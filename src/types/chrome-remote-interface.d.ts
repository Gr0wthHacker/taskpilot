/**
 * Ambient module declaration for chrome-remote-interface.
 *
 * The npm package ships JS only — no .d.ts. We narrow it to `unknown` here
 * and cast through the typed `CdpFactory` shape inside `src/main/browser/cdp.ts`,
 * which is the only consumer. Anyone adding new CDP calls should extend the
 * `CdpFactory` / `CdpClient` types there rather than this declaration.
 */
declare module 'chrome-remote-interface' {
  const cri: unknown;
  export default cri;
}
