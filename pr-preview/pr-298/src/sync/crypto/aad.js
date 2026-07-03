//#region src/sync/crypto/aad.ts
/**
* Canonical, unambiguous AAD (associated data) encoding (§6 "AAD").
*
* AAD binds each ciphertext to its block, workspace, column, and schema
* version so the server can't swap ciphertexts between blocks, between
* workspaces, or between columns of one block.
*
* The fields are variable-length TEXT ids, so a naive concatenation
* lets `"A"‖"BC"` alias `"AB"‖"C"` and defeats the cross-binding. We
* length-prefix every field with a 4-byte big-endian length so the
* decomposition is unambiguous (§6). `schema_version` is folded in as
* its decimal string, length-prefixed like any other field — it equals
* the envelope's `v1` tag and is reconstructable at decrypt time.
*/
var utf8 = new TextEncoder();
var canonicalAad = (fields) => {
	const encoded = fields.map((field) => utf8.encode(field));
	const total = encoded.reduce((sum, bytes) => sum + 4 + bytes.length, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	let offset = 0;
	for (const bytes of encoded) {
		view.setUint32(offset, bytes.length, false);
		offset += 4;
		out.set(bytes, offset);
		offset += bytes.length;
	}
	return out;
};
/** AAD for one encrypted content column of a block. `columnName` is one
*  of `content` | `properties_json` | `references_json`. */
var contentAad = (blockId, workspaceId, columnName) => canonicalAad([
	blockId,
	workspaceId,
	columnName,
	String(1)
]);
/** AAD for the workspace key-check canary (§7). The literal `canary`
*  domain-separates it from any content column. */
var canaryAad = (workspaceId) => canonicalAad([
	workspaceId,
	"canary",
	String(1)
]);
/** AAD for a sealed asset-byte object (§5.1 / §10). Binds the content hash
*  (`sha256:<hex>` — the same value stored in `block.properties.hash` and
*  verified on read), the workspace, the literal `asset-bytes` domain
*  separator, and the schema version. The object is content-addressed and
*  shared by every block carrying these bytes (§10), so it binds the CONTENT
*  HASH, not a block id — binding a block id would stop a co-referencing block
*  from opening it. The `asset-bytes` literal sits in the same slot as a
*  content column name and is disjoint from the three real column names
*  (content | properties_json | references_json), so no content AAD collides
*  with it. */
var assetBytesAad = (contentHash, workspaceId) => canonicalAad([
	contentHash,
	workspaceId,
	"asset-bytes",
	String(1)
]);
//#endregion
export { assetBytesAad, canaryAad, contentAad };

//# sourceMappingURL=aad.js.map