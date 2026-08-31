/**
 * exifr ships its browser builds as bare files with no type declarations, so
 * the lite entry needs declaring by hand. Only the one call we make is typed;
 * `parse` returns whatever tags were picked, which is genuinely unknown at
 * compile time.
 */
declare module 'exifr/dist/lite.esm.mjs' {
  const exifr: {
    parse(
      input: File | Blob | ArrayBuffer | Uint8Array,
      options?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined>
  }
  export default exifr
}
