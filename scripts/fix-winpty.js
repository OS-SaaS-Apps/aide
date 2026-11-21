// Placeholder — intentionally does nothing.
//
// package.json's "postinstall" runs this script before electron-rebuild. The original
// was never committed to the repository and its contents are lost; it was described as
// a "post-install fixup for winpty on Windows" (most likely a patch that let node-pty's
// bundled winpty compile, e.g. by disabling the Spectre-mitigated library requirement
// in node_modules/node-pty/deps/winpty/src/winpty.gyp).
//
// This empty stand-in keeps `npm install` from failing. If node-pty ever fails to build
// during `npm install`, this is the place to restore that fix.
