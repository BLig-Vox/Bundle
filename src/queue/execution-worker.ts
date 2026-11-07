import { pathToFileURL } from "node:url";
import { checkedRouteFile } from "../http/route-definitions.ts";
import type { ExecutableJob } from "./execution.ts";
import { encodeJob } from "./store.ts";
import { runCli } from "../cli/runner.ts";
import { createPrompts } from "../console/prompts.ts";
import { Readable, Writable } from "node:stream";
import { runJobMiddleware } from "./middleware.ts";

declare const self: {
  addEventListener(type:"message",listener:(event:MessageEvent)=>void):void;
  postMessage(message:unknown):void;
  close():void;
};
const controller=new AbortController();
let started=false;
const identifier=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbidden=new Set(["__proto__","prototype","constructor"]);
const validName=(value:unknown):value is string=>typeof value==="string"&&identifier.test(value)&&!forbidden.has(value);
const isClass=(value:unknown)=>typeof value==="function"&&/^\s*class\b/.test(Function.prototype.toString.call(value));

self.addEventListener("message",async event=>{
  if(event.data?.type==="abort"){controller.abort();return;}
  if(event.data?.type!=="start"||started)return;
  started=true;
  let commandExitCode: number | undefined;
  const metadata = () => commandExitCode === undefined ? {} : {commandExitCode};
  try {
    const {root,job}=event.data as {root:string;job:ExecutableJob};
    if (!job) throw new Error("Invalid queued job");
    encodeJob(job);
    await runJobMiddleware({root,references:job.middleware ?? [],context:{job,signal:controller.signal},run:async()=>{
      if ("kind" in job) {
        const prompts = createPrompts({input: Readable.from([]), output: new Writable({write(_chunk,_encoding,callback){callback();}})});
        commandExitCode = await runCli(job.argv, {root, signal:controller.signal, handleSignals:false, prompts, output:()=>{}, error:()=>{}});
        if (commandExitCode !== 0) throw new Error("Queued command failed");
        return;
      }
      if(!validName(job.export)||(job.method!==undefined&&!validName(job.method)))throw new Error("Invalid queued handler");
      const path=await checkedRouteFile(root,job.module);
      controller.signal.throwIfAborted();
      const module=await import(pathToFileURL(path).href);
      controller.signal.throwIfAborted();
      if(!Object.hasOwn(module,job.export))throw new Error("Missing queued export");
      const target:unknown=module[job.export];
      if(job.method!==undefined){
        if(!isClass(target))throw new Error("Queued class required");
        const Class=target as new()=>object;
        const method=Object.getOwnPropertyDescriptor(Class.prototype,job.method)?.value;
        if(typeof method!=="function")throw new Error("Queued own method required");
        await method.call(new Class(),job.payload,controller.signal);
      }else{
        if(typeof target!=="function"||isClass(target))throw new Error("Queued function required");
        await target(job.payload,controller.signal);
      }
    }});
    // Middleware may catch downstream errors, but cannot turn a nonzero command into success.
    self.postMessage({type:"done",status:commandExitCode !== undefined && commandExitCode !== 0 ? "failed" : "completed",...metadata()});
  }catch{
    // Never transmit trusted application exception/payload details to the caller.
    self.postMessage({type:"done",status:"failed",...metadata()});
  }finally{self.close();}
});
