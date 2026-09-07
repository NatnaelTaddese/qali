// Applies the saved theme class before first paint. Lives in its own file
// rather than inline so the Content-Security-Policy in public/_headers can
// forbid inline script outright.
(function () {
  try {
    var theme = localStorage.getItem("vite-ui-theme") || "light";
    if (theme === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  } catch (e) {}
})();
