import { useEffect, useState, type ReactNode, type ComponentType } from "react";
import type { PageProps } from "./ResourcePage.tsx";

export function ResourceNavigation({ children, onExpired, pages }: PageProps & { children: ReactNode; pages: readonly { name: string; hash: string; Page: ComponentType<PageProps> }[] }) {
  const [hash, setHash] = useState(() => typeof window === "undefined" ? "#/notes" : window.location.hash || "#/notes");
  useEffect(() => {
    const update = () => setHash(window.location.hash || "#/notes");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const selected = pages.find(page => page.hash === hash);
  const Page = selected?.Page;
  return <>
    <nav aria-label="Private pages" className="flex flex-wrap gap-4">
      <a href="#/notes" aria-current={hash === "#/notes" ? "page" : undefined}>Notes</a>
      {pages.map(page => <a key={page.hash} href={page.hash} aria-current={hash === page.hash ? "page" : undefined}>{page.name}</a>)}
    </nav>
    {Page ? <Page key={hash} onExpired={onExpired} /> : hash === "#/notes" ? children : <p role="status">Page not found. Choose a page above.</p>}
  </>;
}
