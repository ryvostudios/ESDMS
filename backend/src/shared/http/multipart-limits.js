// ESDMS multipart contracts contain flat scalar fields only. Repeated file
// parts (Gate evidence) are not nested text fields. Keep parser work bounded
// before controller validation and before any storage/database side effects.
// Busboy treats fieldSize as an exclusive ceiling; callers reserve one byte
// beyond fixed-length UUID/revision values. Controller validation still applies.
export function flatMultipartLimits({ fileSize, files = 1, fields, fieldSize, fieldNameSize }) {
  return {
    fileSize, files, fields, parts: files + fields, fieldSize, fieldNameSize,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
  };
}
