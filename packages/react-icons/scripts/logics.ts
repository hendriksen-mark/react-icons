import { Cheerio, load as cheerioLoad } from "cheerio";
import type { Element as CheerioElement } from "domhandler";
import camelcase from "camelcase";
import { promises as fs } from "fs";
import path from "path";
import { type IconDefinitionContent } from "./_types";
import { glob } from "./glob";
import { type IconManifestType, IconTree } from "../src";

export async function getIconFiles(content: IconDefinitionContent) {
  if (typeof content.files === "string") {
    const pattern = content.files.replace(/\\/g, "/"); // convert windows path
    return glob(pattern);
  }
  return content.files();
}

export async function convertIconData(
  svg: string,
  multiColor: boolean | undefined,
) {
  const $doc = cheerioLoad(svg, { xmlMode: true });
  const $svg = $doc("svg");

  const shouldDropNamespacedAttr = (name: string) => {
    if (!name.includes(":")) {
      return false;
    }
    return !name.startsWith("xlink:");
  };

  const normalizeAttrName = (name: string) => {
    if (name.startsWith("aria-")) {
      return name;
    }
    if (name.startsWith("xlink:")) {
      const suffix = name.slice("xlink:".length);
      return `xlink${camelcase(suffix, { pascalCase: true })}`;
    }
    return camelcase(name);
  };

  const parseInlineStyle = (value: string) =>
    value
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf(":");
        if (separatorIndex === -1) {
          return null;
        }
        const name = entry.slice(0, separatorIndex).trim();
        const styleValue = entry.slice(separatorIndex + 1).trim();
        if (!name || !styleValue) {
          return null;
        }
        return { name, value: styleValue };
      })
      .filter((item): item is { name: string; value: string } => item !== null);

  // filter/convert attributes
  // 1. remove class attr
  // 2. convert to camelcase ex: fill-opacity => fillOpacity
  const attrConverter = (attribs: Record<string, string>, tagName: string) => {
    if (!attribs) {
      return {};
    }

    const converted = {} as Record<string, string>;
    const addAttr = (name: string, value: string) => {
      if (shouldDropNamespacedAttr(name)) {
        return;
      }

      const newName = normalizeAttrName(name);
      switch (newName) {
        case "fill":
        case "stroke":
          if (value === "none" || value === "currentColor" || multiColor) {
            converted[newName] = value;
          }
          break;
        case "pId":
          break;
        case "dataName":
          break;
        case "style":
          // React expects style to be an object, so convert inline style entries
          // into normal SVG attributes and skip string style assignment.
          parseInlineStyle(value).forEach((styleEntry) => {
            addAttr(styleEntry.name, styleEntry.value);
          });
          break;
        default:
          if (name.startsWith("data")) {
            break;
          }
          converted[newName] = value;
          break;
      }
    };

    Object.keys(attribs)
      .filter(
        (name) =>
          ![
            "class",
            ...(tagName === "svg"
              ? ["xmlns", "xmlns:xlink", "xml:space", "width", "height"]
              : []),
          ].includes(name),
      )
      .forEach((name) => {
        addAttr(name, attribs[name]);
      });

    return converted;
  };

  // convert to [ { tag: 'path', attr: { d: 'M436 160c6.6 ...', ... }, child: { ... } } ]
  function elementToTree(element: Cheerio<CheerioElement>): IconTree[] {
    return (
      element
        // ignore style, title tag
        .filter(
          (_, e) => !!(e.tagName && !["style", "title"].includes(e.tagName)),
        )
        // convert to AST recursively
        .map((_, e) => ({
          tag: e.tagName,
          attr: attrConverter(e.attribs, e.tagName),
          child:
            e.children && e.children.length
              ? elementToTree($doc(e.children) as Cheerio<CheerioElement>)
              : [],
        }))
        .get()
    );
  }

  const tree = elementToTree($svg);
  return tree[0]; // like: [ { tag: 'path', attr: { d: 'M436 160c6.6 ...', ... }, child: { ... } } ]
}

export async function copyRecursive(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(sPath, dPath);
    } else {
      await fs.copyFile(sPath, dPath);
    }
  }
}

export async function rmDirRecursive(dest: string) {
  await fs.rm(dest, { recursive: true, force: true });
}

export function buildPackageExports(icons: IconManifestType[]) {
  const exports: Record<
    string,
    {
      types: string;
      require: string;
      import: string;
      default: string;
    }
  > = {
    ".": {
      types: "./index.d.ts",
      require: "./index.js",
      import: "./index.mjs",
      default: "./index.mjs",
    },
    "./lib": {
      types: "./lib/index.d.ts",
      require: "./lib/index.js",
      import: "./lib/index.mjs",
      default: "./lib/index.mjs",
    },
  };

  icons.forEach((icon) => {
    exports[`./${icon.id}`] = {
      types: `./${icon.id}/index.d.ts`,
      require: `./${icon.id}/index.js`,
      import: `./${icon.id}/index.mjs`,
      default: `./${icon.id}/index.mjs`,
    };
  });

  return exports;
}
