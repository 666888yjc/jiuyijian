import { useEffect, useState } from "react";

export function getHashPath(): string {
  const h = window.location.hash.slice(1);
  return h.startsWith("/") ? h : "/";
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useHashPath(): string {
  const [path, setPath] = useState(getHashPath);
  useEffect(() => {
    const onChange = () => setPath(getHashPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}
