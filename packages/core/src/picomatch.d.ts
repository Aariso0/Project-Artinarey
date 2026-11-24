declare module 'picomatch' {
  type Matcher = (input: string) => boolean;
  type Options = { dot?: boolean; nocase?: boolean; [key: string]: unknown };
  const picomatch: {
    (glob: string, options?: Options): Matcher;
    makeRe(glob: string, options?: Options): RegExp | false;
    isMatch(input: string, glob: string, options?: Options): boolean;
  };
  export default picomatch;
}
