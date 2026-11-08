import { render } from "../pages/Home.ts";
import { htmlResponse } from "../web/response.ts";

export function handler(_request: Request): Response {
  return htmlResponse(render());
}
