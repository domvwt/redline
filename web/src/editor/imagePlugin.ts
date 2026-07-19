import { Plugin } from "@milkdown/kit/prose/state";

/**
 * Renders images with relative paths resolved against the open document's
 * directory, served through the daemon's read-only /api/file endpoint.
 * Absolute URLs and data: URIs pass through untouched.
 */
export function createImagePlugin(docPath: string): Plugin {
  const docDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/") + 1) : "";

  const resolveSrc = (src: string): string => {
    if (!src) return src;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith("data:")) return src;
    const rel = src.startsWith("/") ? src.slice(1) : docDir + src;
    const out: string[] = [];
    for (const part of rel.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return `/api/file?path=${encodeURIComponent(out.join("/"))}`;
  };

  const render = (attrs: { src?: string; alt?: string; title?: string }) => {
    const img = document.createElement("img");
    img.src = resolveSrc(attrs.src ?? "");
    if (attrs.alt) img.alt = attrs.alt;
    if (attrs.title) img.title = attrs.title;
    img.className = "rl-image";
    return { dom: img };
  };

  return new Plugin({
    props: {
      nodeViews: {
        image: (node) => render(node.attrs),
        "image-block": (node) => render(node.attrs),
      },
    },
  });
}
