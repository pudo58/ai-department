// jsdom ships no types. The Figma harness needs a second, separate DOM (the plugin's UI), so it uses the class directly.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly window: any;
  }
}
