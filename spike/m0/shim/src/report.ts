export function buildReport() {
  return {
    cwd: process.cwd(),
    argv: process.argv,
    envNames: Object.keys(process.env).sort(),
  };
}
