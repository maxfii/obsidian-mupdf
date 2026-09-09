declare module '*.c' {
	const wasmBytes: Uint8Array;
	export default wasmBytes;
}
