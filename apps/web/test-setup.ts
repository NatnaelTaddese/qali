// Give the unit tests a DOM. jsdom rather than happy-dom: DOMPurify (the
// description sanitizer under test) is developed and tested against jsdom, and
// under happy-dom it silently passes markup through.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://localhost/",
});
const { window } = dom;
const globals = globalThis as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.localStorage = window.localStorage;
globals.sessionStorage = window.sessionStorage;
for (const key of [
  "DOMParser",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLAnchorElement",
  "HTMLTemplateElement",
  "HTMLFormElement",
  "NodeFilter",
  "NamedNodeMap",
  "DocumentFragment",
  "Text",
  "Comment",
  "Attr",
  "MutationObserver",
]) {
  globals[key] = (window as unknown as Record<string, unknown>)[key];
}
