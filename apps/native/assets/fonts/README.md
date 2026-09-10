# Fonts

Static instances of the same variable fonts the web app loads through
`@fontsource-variable/*` (see `packages/ui/src/styles/globals.css`), cut with
fontTools `varLib.instancer` from the Google Fonts sources:

- `Lexend-{Regular,Medium,SemiBold,Bold}.ttf` — `Lexend[wght].ttf` at wght 400 / 500 / 600 / 700.
- `Fraunces-{Medium,Bold,ExtraBold}.ttf` — `Fraunces[SOFT,WONK,opsz,wght].ttf` at
  wght 500 / 700 / 800 with `SOFT=100 WONK=1` (the web's
  `--font-display--font-variation-settings`) and `opsz=24`.

Every face carries the bare family name (`Lexend`, `Fraunces`) in its name
table so React Native resolves `fontWeight` within the family on iOS; the
`expo-font` plugin in `app.json` declares the same families for Android.
Add a weight by cutting another instance and listing it in both places.

Both families are licensed under the SIL Open Font License 1.1
(`OFL-Lexend.txt`, `OFL-Fraunces.txt`).
