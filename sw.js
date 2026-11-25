(function() {
	// src/sw/assets.ts
	/**
	* Which same-origin runtime assets the service worker serves cache-first from
	* the generation cache. Kept globals-free (primitives in, boolean out — no
	* `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
	* tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
	* (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
	*
	* `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
	* extension; the SW ALSO serves cache-first by `request.destination` (below), so
	* strictly the served set is a superset of the precached set. That superset is
	* empty in practice — every emitted dist asset carries a recognized extension,
	* so a destination-matched request always also matches by extension and was
	* precached. Importing the ONE extension definition here (instead of duplicating
	* the literal in the build script and diffing it in a test) keeps the two in
	* lockstep on the axis the precache is actually built from; the invariant that
	* closes the gap is "every served asset has a recognized extension", which holds
	* for our own emitted output.
	*/
	var ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/;
	var ASSET_DESTINATIONS = /* @__PURE__ */ new Set([
		"script",
		"style",
		"worker",
		"font",
		"image"
	]);
	/**
	* True for a same-origin request the SW serves cache-first within the
	* generation. Match by `request.destination` first (covers the common cases a
	* browser labels) with an extension fallback for anything left as an empty
	* destination.
	*/
	var isCacheableAsset = (destination, pathname, sameOrigin) => sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname));
	/**
	* The fingerprint the build stamps for each precached file and the worker
	* recomputes over the bytes it fetched: hex SHA-256 cut to 64 bits, enough to
	* tell two builds' bytes apart. The one definition both sides use.
	*/
	var contentDigest = async (bytes) => {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	// src/data/dbFileSiblings.ts
	/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
	var WRITE_AHEAD_SIDECAR_SUFFIXES = ["-wa0", "-wa1"];
	/**
	* SQLite's own crash-recovery files. These must be removed BEFORE the main
	* `.db`: left beside a fresh database of the same name, SQLite replays them.
	*
	* Wider than what this app produces, deliberately: deletion should clear
	* anything SQLite could replay, whoever wrote it. Restoring is the opposite and
	* uses a narrower whitelist — see `exportSqliteDb`.
	*/
	var SQLITE_JOURNAL_SUFFIXES = [
		"-journal",
		"-wal",
		"-shm"
	];
	[...SQLITE_JOURNAL_SUFFIXES, ...WRITE_AHEAD_SIDECAR_SUFFIXES];
	// src/sw/preview.ts
	/**
	* PR-preview subtree gating. github.io is ONE origin for production
	* (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
	* production/root SW's scope is a PREFIX of every preview path, and since we
	* never `clients.claim()`, the production SW controls a freshly-opened preview
	* page until it reloads — and would otherwise cache the preview's shell +
	* assets under production's OWN keys, poisoning the offline production shell
	* with an unmerged build. So a SW refuses to serve/cache a preview subtree it
	* doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
	*
	* Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
	* directly and shared without dragging worker types.
	*/
	var PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//;
	/**
	* True when this SW must NOT touch a request: the request targets a preview
	* subtree that this scope does not own. A preview-scoped SW (its own scope is
	* under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
	*/
	var isForeignPreviewRequest = (ownScopeIsPreview, pathname) => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname);
	// src/sw/ledger.ts
	/**
	* Pure decisions over the generation ledger — an install-ordered list of
	* BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
	* (reading/writing the ledger Response in the meta cache); the retention math
	* lives here so it unit-tests without a cache.
	*
	* Each deploy is an immutable generation with its own km-shell-<id> /
	* km-assets-<id> caches. On activate we keep the most recent `keep`
	* generations (so a tab still on a prior build has a consistent cache to read
	* from) and GC the rest.
	*/
	/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
	var computeKeepIds = (ledger, keep) => ledger.slice(Math.max(0, ledger.length - keep));
	/**
	* The ids that have aged out of the keep-window and whose caches should be
	* GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
	*/
	var computeExpiredIds = (ledger, keep) => ledger.slice(0, Math.max(0, ledger.length - keep));
	/**
	* Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
	* on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
	* (written before timestamps existed) — the latter has no timestamp, which the
	* sweeper reads as "staleness unprovable → never reap". Anything else (null,
	* garbage, non-array ids) degrades to an empty ledger.
	*/
	var normalizeLedger = (raw) => {
		if (Array.isArray(raw)) return {
			ids: raw,
			updatedAt: void 0
		};
		if (raw && typeof raw === "object" && Array.isArray(raw.ids)) {
			const { ids, updatedAt } = raw;
			return {
				ids,
				updatedAt: typeof updatedAt === "number" ? updatedAt : void 0
			};
		}
		return {
			ids: [],
			updatedAt: void 0
		};
	};
	/**
	* Decide which OTHER-scope generation caches a sweep should reclaim. Cache
	* Storage is shared per-origin, so a client accumulates the caches of every PR
	* preview it ever visited; once a PR is merged/closed its preview SW never runs
	* again to GC them, so they leak forever. This sweep (run from any active SW's
	* activate) reclaims them — but ONLY:
	*   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
	*     is NEVER a preview scope, so it can never be reaped here — the sweep is
	*     structurally incapable of touching prod caches.
	*   - that are STALE: a numeric updatedAt older than staleMs. A legacy
	*     untimestamped ledger (updatedAt undefined) is never reaped — we can't
	*     prove it's abandoned. The current scope's own ledger was just re-stamped
	*     on install, so it's fresh and self-excluded.
	* A generation id still referenced by any KEPT (non-reaped) ledger is spared —
	* two deploys can in principle share a build sha, and we must not delete a cache
	* a live scope depends on. The stale ledger ENTRY is removed regardless (the
	* scope is gone), even when its cache was shared-protected.
	*/
	var computeReapableCaches = ({ ledgers, now, staleMs, selfScopeUrl }) => {
		const isPreviewScope = (scopeUrl) => {
			try {
				return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname);
			} catch {
				return false;
			}
		};
		const isStale = (l) => typeof l.updatedAt === "number" && now - l.updatedAt > staleMs;
		const reapable = ledgers.filter((l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l));
		const reapableSet = new Set(reapable);
		const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids));
		const reapIds = /* @__PURE__ */ new Set();
		for (const l of reapable) for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id);
		return {
			reapIds: [...reapIds],
			ledgerScopeUrls: reapable.map((l) => l.scopeUrl)
		};
	};
	// src/utils/idbKeyedStore.ts
	/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
	var promisifyRequest = (request) => new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
	*  A readwrite write is only durable once the tx commits — `onsuccess` fires
	*  earlier, while the tx is still open — so a caller that navigates/reloads
	*  right after a write can have an un-committed tx rolled back. Handlers are
	*  registered synchronously by the caller (before any await) so an `oncomplete`
	*  that fires before we start awaiting can't be missed. */
	var txCommitted = (transaction) => new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
	});
	/** Record-id prefix for all of an owner's records. The trailing `:` plus
	*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
	*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
	*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
	var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
	/** Composite record id. Each segment is encoded so a delimiter inside an id
	*  can't make two distinct `(owner, id)` pairs collide. */
	var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
	/**
	* A cached connection to one named DB + one object store, with commit-durable
	* transactions. Each instance owns its own connection handle, so constructing a
	* fresh instance against the same DB models a page reload (a new tab/handle
	* reopening persisted data) — which is exactly how the consumers' tests verify
	* durability.
	*/
	var IdbKeyedStore = class {
		dbName;
		storeName;
		version;
		dbPromise = null;
		constructor(dbName, storeName, version = 1) {
			this.dbName = dbName;
			this.storeName = storeName;
			this.version = version;
		}
		openDb() {
			if (!this.dbPromise) {
				const opened = new Promise((resolve, reject) => {
					const request = indexedDB.open(this.dbName, this.version);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
					};
					request.onsuccess = () => {
						const db = request.result;
						db.onclose = () => {
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						db.onversionchange = () => {
							db.close();
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						resolve(db);
					};
					request.onerror = () => reject(request.error);
				}).catch((err) => {
					if (this.dbPromise === opened) this.dbPromise = null;
					throw err;
				});
				this.dbPromise = opened;
			}
			return this.dbPromise;
		}
		/**
		* Open a transaction and return its object store plus a commit fence. PRIVATE
		* and footgun-laden by design — the caller must issue its first request
		* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
		* on an error path) or a tx abort surfaces as an unhandled rejection. The public
		* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
		* that contract so callers never have to.
		*/
		async openTransaction(mode) {
			const transaction = (await this.openDb()).transaction(this.storeName, mode);
			const committed = txCommitted(transaction);
			return {
				store: transaction.objectStore(this.storeName),
				committed
			};
		}
		/**
		* Run `body` against the store within one transaction and resolve on the
		* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
		* issue its first request synchronously — it is invoked in the same task that
		* created the tx (see the file header on activeness). If `body` rejects (or the
		* commit fence does), the fence's rejection is observed here so it can't surface
		* as an unhandled rejection, and the original error propagates. Use for cursor
		* scans / read-modify-write; single-request ops use {@link tx}.
		*/
		async runTransaction(mode, body) {
			const { store, committed } = await this.openTransaction(mode);
			try {
				const result = await body(store);
				await committed;
				return result;
			} catch (err) {
				committed.catch(() => {});
				throw err;
			}
		}
		/**
		* Run a single request against the store, resolving on the transaction COMMIT
		* (durability). The common case; multi-request / cursor work uses
		* {@link runTransaction}.
		*/
		async tx(mode, run) {
			return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
		}
		/**
		* Walk every record whose key starts with `prefix` (the per-owner namespace
		* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
		* commit-durable transaction. A value cursor, because `visit` reads
		* `cursor.value`; the `:`-delimited prefix is collision-free across owners, so
		* a scan never reaches a sibling owner. `visit` is synchronous
		* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
		* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
		* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
		* readwrite scan's partial writes) and rejects with that error.
		*/
		async scanByPrefix(mode, prefix, visit) {
			await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					try {
						if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
						cursor.continue();
					} catch (err) {
						try {
							store.transaction.abort();
						} catch {}
						reject(err);
					}
				};
				request.onerror = () => reject(request.error);
			}));
		}
		/**
		* Delete every record whose key starts with `prefix`, in one commit-durable
		* readwrite transaction. One ranged delete rather than a value cursor: a
		* cursor deserialises every record in the store to test its key, and some
		* stores hold multi-MB records. The range is exactly "starts with": every
		* key from `prefix` up to, excluding, the prefix with its last code unit
		* incremented.
		*/
		async deleteByPrefix(prefix) {
			const last = prefix.charCodeAt(prefix.length - 1);
			if (last === 65535) throw new Error("deleteByPrefix: the prefix has no successor");
			const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
			await this.tx("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, upper, false, true)));
		}
	};
	// src/sw/bootStore.ts
	/**
	* The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
	* a cold launch answers them without touching Cache Storage. On iOS the first
	* Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
	* which cache or how many entries (measured against an IndexedDB open in the
	* same worker: 17 ms); Cache Storage stays the store for everything lazy.
	*
	* Entries are keyed by build id, so a worker only ever serves its own
	* generation's bytes and the activate GC reaps a generation by prefix.
	*/
	var bootKeyPrefix = (buildId) => idbKeyPrefix(buildId);
	var bootKey = (buildId, url) => idbRecordId(buildId, url);
	var idbBootStore = () => {
		const store = new IdbKeyedStore("km-boot", "entries");
		return {
			get: (key) => store.tx("readonly", (s) => s.get(key)),
			putAll: (entries) => store.runTransaction("readwrite", async (s) => {
				for (const [key, entry] of entries) s.put(entry, key);
			}),
			deletePrefix: (prefix) => store.deleteByPrefix(prefix)
		};
	};
	// src/sw/previewDatabases.ts
	var SERVICE_WORKER_META_CACHE = "km-meta";
	var PREVIEW_DATABASE_RECORD_BASENAME = "__km_database__";
	var previewDatabaseRecordInfo = (recordUrl, ledgerBasename) => {
		try {
			const url = new URL(recordUrl);
			const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`;
			const markerIndex = url.pathname.indexOf(marker);
			if (markerIndex < 0) return null;
			const encodedName = url.pathname.slice(markerIndex + marker.length);
			if (!encodedName || encodedName.includes("/")) return null;
			const scopePath = url.pathname.slice(0, markerIndex + 1);
			return {
				scopeUrl: `${`${url.origin}${scopePath}`}${ledgerBasename}`,
				name: decodeURIComponent(encodedName)
			};
		} catch {
			return null;
		}
	};
	// src/sw/worker.ts
	/**
	* The service worker's orchestration — ledger I/O, install precache, activate
	* GC, and fetch routing — as a factory parameterized by its globals
	* (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
	* entry (src/sw/sw.ts) constructs one of these with the real globals + injected
	* build config and wires it to the SW events; tests construct one with an
	* in-memory CacheStorage and a stub fetch and drive install/activate/fetch
	* directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
	* makes it importable + unit-testable outside a worker.
	*
	* The versioning model this implements is documented in the sw.ts header.
	*/
	var CACHE_PREFIX = "km-";
	var VENDOR_HOSTS = /* @__PURE__ */ new Set(["esm.sh"]);
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const resolveManifest = (manifest) => Object.entries(manifest).map(([path, digest]) => [toScopeUrl(path), digest]);
		const SHELL_ENTRIES = resolveManifest(config.precacheShell);
		const PRECACHE_ENTRIES = resolveManifest(config.precacheAssets);
		const PRECACHE_REST_ENTRIES = resolveManifest(config.precacheRestAssets);
		const PRECACHE_ASSETS = PRECACHE_ENTRIES.map(([url]) => url);
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [[SHELL_CACHE, [SHELL_URL]], [ASSET_CACHE, PRECACHE_ASSETS]];
		const BOOT_URLS = new Set(BOOT_SET.flatMap(([, urls]) => urls));
		const deleteGeneration = (id) => [
			caches.delete(`${CACHE_PREFIX}shell-${id}`),
			caches.delete(`${CACHE_PREFIX}assets-${id}`),
			env.bootStore?.deletePrefix(bootKeyPrefix(id)).catch(() => void 0)
		];
		const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname);
		const LEDGER_BASENAME = "__km_generations__";
		const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`);
		const readLedgerEntry = async () => {
			try {
				const res = await (await caches.open(META_CACHE)).match(LEDGER_KEY);
				if (!res) return {
					ids: [],
					updatedAt: void 0
				};
				return normalizeLedger(await res.json());
			} catch {
				return {
					ids: [],
					updatedAt: void 0
				};
			}
		};
		const readLedger = async () => (await readLedgerEntry()).ids;
		const writeLedgerEntry = async (entry) => {
			const cache = await caches.open(META_CACHE);
			const nextEntry = {
				...entry,
				updatedAt: now()
			};
			await cache.put(LEDGER_KEY, new Response(JSON.stringify(nextEntry), { headers: { "content-type": "application/json" } }));
		};
		let ledgerMutationChain = Promise.resolve();
		const mutateLedgerEntry = async (mutate) => {
			const run = ledgerMutationChain.then(async () => {
				const entry = await readLedgerEntry();
				await writeLedgerEntry(await mutate(entry));
			});
			ledgerMutationChain = run.catch(() => {});
			await run;
		};
		const recordGeneration = async (id) => {
			await mutateLedgerEntry((entry) => {
				const ids = entry.ids.filter((x) => x !== id);
				ids.push(id);
				return {
					...entry,
					ids
				};
			});
		};
		const forgetGeneration = async (id) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: entry.ids.filter((x) => x !== id)
			}));
		};
		const writeLedger = async (ids) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids
			}));
		};
		const trimLedger = async () => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: computeKeepIds(entry.ids, keepGenerations)
			}));
		};
		let lastTouchAt = 0;
		const maybeTouchOwnLedger = (waitUntil) => {
			if (!OWN_SCOPE_IS_PREVIEW) return;
			const t = now();
			if (t - lastTouchAt <= config.touchIntervalMs) return;
			lastTouchAt = t;
			const touch = (async () => {
				try {
					await mutateLedgerEntry((entry) => entry);
				} catch {}
			})();
			if (waitUntil) waitUntil(touch);
		};
		const install = async () => {
			try {
				await precache();
			} catch (err) {
				await Promise.allSettled(deleteGeneration(buildId));
				await forgetGeneration(buildId).catch(() => {});
				throw err;
			}
		};
		const precache = async () => {
			await recordGeneration(buildId);
			const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSET_CACHE)]);
			const fetchInto = async (cache, url, digest, mode) => {
				const res = await fetch(new Request(url, { cache: mode })).catch(() => null);
				if (!res || !res.ok) return;
				const body = await res.clone().arrayBuffer().catch(() => null);
				if (!body) return;
				if (await contentDigest(body) !== digest) throw new Error(`[sw] ${url} differs from build ${buildId}'s copy; another deploy is being served`);
				await cache.put(url, res).catch(() => {});
			};
			const runPooled = async (entries, limit, task) => {
				let next = 0;
				let failure;
				const worker = async () => {
					while (!failure && next < entries.length) {
						const [url, digest] = entries[next++];
						try {
							await task(url, digest);
						} catch (err) {
							failure ??= { err };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
				if (failure) throw failure.err;
			};
			await runPooled(SHELL_ENTRIES, SHELL_ENTRIES.length, (u, d) => fetchInto(shell, u, d, "reload"));
			await runPooled(PRECACHE_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
			await seedBootStore();
			await runPooled(PRECACHE_REST_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
		};
		const seedBootStore = async () => {
			const store = env.bootStore;
			if (!store) return;
			try {
				for (const [cacheName, urls] of BOOT_SET) {
					const cache = await caches.open(cacheName);
					const entries = [];
					for (const url of urls) {
						const cached = await cache.match(url);
						if (!cached) continue;
						entries.push([bootKey(buildId, url), {
							status: cached.status,
							contentType: cached.headers.get("content-type") ?? "application/octet-stream",
							body: await cached.arrayBuffer()
						}]);
					}
					await store.putAll(entries);
				}
			} catch {}
		};
		const bootStoreFirst = async (url, fallback) => {
			const store = env.bootStore;
			if (store && BOOT_URLS.has(url)) try {
				const entry = await store.get(bootKey(buildId, url));
				if (entry) {
					env.mark?.("bootStoreHitAt");
					return new Response(entry.body, {
						status: entry.status,
						headers: { "content-type": entry.contentType }
					});
				}
			} catch {}
			return fallback();
		};
		const activate = async () => {
			const ledger = await readLedger();
			const keepIds = new Set(computeKeepIds(ledger, keepGenerations));
			const expiredIds = computeExpiredIds(ledger, keepGenerations);
			await Promise.all(expiredIds.flatMap(deleteGeneration));
			if (ledger.length > keepIds.size) try {
				await trimLedger();
			} catch {}
			try {
				await sweepStalePreviewGenerations();
			} catch {}
		};
		const sweepStalePreviewGenerations = async () => {
			const meta = await caches.open(META_CACHE);
			const ledgers = [];
			const databaseRecords = [];
			for (const req of await meta.keys()) {
				if (req.url.endsWith(`/${LEDGER_BASENAME}`)) {
					const res = await meta.match(req);
					if (!res) continue;
					const { ids, updatedAt } = normalizeLedger(await res.json().catch(() => null));
					ledgers.push({
						scopeUrl: req.url,
						ids,
						updatedAt
					});
					continue;
				}
				const recordInfo = previewDatabaseRecordInfo(req.url, LEDGER_BASENAME);
				if (recordInfo) {
					const res = await meta.match(req);
					const raw = res ? await res.json().catch(() => null) : null;
					databaseRecords.push({
						...recordInfo,
						recordUrl: req.url,
						updatedAt: databaseRecordUpdatedAt(raw)
					});
				}
			}
			const sweepNow = now();
			const plan = computeReapableCaches({
				ledgers,
				now: sweepNow,
				staleMs: config.staleScopeMs,
				selfScopeUrl: LEDGER_KEY
			});
			await Promise.all([
				sweepStalePreviewDatabases(meta, {
					ledgerScopeUrls: plan.ledgerScopeUrls,
					knownLedgerScopeUrls: ledgers.map(({ scopeUrl }) => scopeUrl),
					databaseRecords,
					sweepNow,
					staleMs: config.staleScopeMs
				}),
				...plan.reapIds.flatMap(deleteGeneration),
				...plan.ledgerScopeUrls.map((url) => meta.delete(url))
			]);
		};
		const databaseRecordUpdatedAt = (raw) => {
			if (!raw || typeof raw !== "object") return void 0;
			const { updatedAt } = raw;
			return typeof updatedAt === "number" ? updatedAt : void 0;
		};
		const previewIdForScopeUrl = (scopeUrl) => {
			try {
				return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null;
			} catch {
				return null;
			}
		};
		const isDatabaseNameForPreviewScope = (databaseName, scopeUrl) => {
			const previewId = previewIdForScopeUrl(scopeUrl);
			if (!previewId) return false;
			const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^kmp-v\\d+~${escapedPreviewId}~[A-Za-z0-9_-]*\\.db$`).test(databaseName);
		};
		const databaseRecordsToSweep = (ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs) => {
			const reapedScopes = new Set(ledgerScopeUrls);
			const knownScopes = new Set(knownLedgerScopeUrls);
			const records = [];
			const seen = /* @__PURE__ */ new Set();
			for (const record of databaseRecords) {
				const orphanedStaleRecord = typeof record.updatedAt === "number" && sweepNow - record.updatedAt > staleMs && !knownScopes.has(record.scopeUrl);
				if (!reapedScopes.has(record.scopeUrl) && !orphanedStaleRecord) continue;
				if (!isDatabaseNameForPreviewScope(record.name, record.scopeUrl)) continue;
				const key = `${record.scopeUrl}\n${record.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
			return records;
		};
		const sweepStalePreviewDatabases = async (meta, { ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs }) => {
			const databases = databaseRecordsToSweep(ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs);
			await Promise.all(databases.map(async ({ name, recordUrl }) => {
				try {
					await deleteOpfsSqliteDatabase(name);
					await deleteIndexedDatabase(name).catch(() => {});
				} catch {
					return;
				}
				await meta.delete(recordUrl).catch(() => false);
			}));
		};
		const deleteOpfsSqliteDatabase = async (databaseName) => {
			if (typeof env.storage?.getDirectory !== "function") return;
			const root = await env.storage.getDirectory();
			const journalFailure = (await Promise.allSettled(SQLITE_JOURNAL_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)))).find((result) => result.status === "rejected");
			if (journalFailure) throw journalFailure.reason;
			await removeOpfsEntryIfExists(root, databaseName);
			await Promise.allSettled(WRITE_AHEAD_SIDECAR_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)));
		};
		const removeOpfsEntryIfExists = async (root, name) => {
			try {
				await root.removeEntry(name);
			} catch (err) {
				if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
			}
		};
		const deleteIndexedDatabase = async (databaseName) => {
			const idb = env.indexedDB;
			if (typeof idb?.deleteDatabase !== "function") return;
			if (typeof idb.databases === "function") {
				const existing = await idb.databases().catch(() => null);
				if (existing && !existing.some((db) => db.name === databaseName)) return;
			}
			await new Promise((resolve, reject) => {
				const request = idb.deleteDatabase(databaseName);
				let settled = false;
				const settle = (fn) => {
					if (settled) return;
					settled = true;
					fn();
				};
				request.onsuccess = () => settle(resolve);
				request.onerror = () => settle(() => reject(request.error));
				request.onblocked = () => settle(() => reject(/* @__PURE__ */ new Error(`IndexedDB delete blocked for ${databaseName}`)));
			});
		};
		const isNavigationRequest = (request) => request.mode === "navigate" || request.method === "GET" && (request.headers.get("accept")?.includes("text/html") ?? false);
		const isSameOrigin = (url) => url.origin === env.origin;
		const isVendor = (url) => VENDOR_HOSTS.has(url.hostname);
		const shellCacheFirst = async (request, shellURL) => {
			const cache = await caches.open(SHELL_CACHE);
			env.mark?.("shellCacheOpenedAt");
			const cached = await cache.match(shellURL);
			env.mark?.("shellCacheMatchedAt");
			if (cached) return cached;
			const fresh = await fetch(request);
			if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {});
			return fresh;
		};
		const assetCacheFirst = async (request) => {
			const assets = await caches.open(ASSET_CACHE);
			const cached = await assets.match(request) || await (await caches.open(SHELL_CACHE)).match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		const cacheFirst = async (request, cacheName) => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		/**
		* Route a GET request. Returns a Response promise for the entry to
		* `respondWith`, or undefined to NOT intercept (let the browser handle it —
		* non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
		* like version.json that must stay fresh).
		*/
		const handleFetch = (request, waitUntil) => {
			if (request.method !== "GET") return void 0;
			const url = new URL(request.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
			maybeTouchOwnLedger(waitUntil);
			if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return void 0;
			if (isNavigationRequest(request) && isSameOrigin(url)) {
				if (url.pathname === scopeURL.pathname || url.href.split(/[?#]/)[0] === SHELL_URL) return bootStoreFirst(SHELL_URL, () => shellCacheFirst(request, SHELL_URL));
				return shellCacheFirst(request, SHELL_URL);
			}
			if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) return bootStoreFirst(request.url, () => assetCacheFirst(request));
			if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE);
		};
		return {
			install,
			activate,
			handleFetch,
			readLedger,
			writeLedger,
			recordGeneration
		};
	};
	// src/sw/sw.ts
	var bootMarks = {
		timeOrigin: performance.timeOrigin,
		evaluatedAt: 0,
		firstNavReceivedAt: 0,
		firstNavAnsweredAt: 0
	};
	var mark = (name) => {
		if (!bootMarks[name]) bootMarks[name] = performance.now();
	};
	var sw = createServiceWorker({
		buildId: "b2df01f3a545-9aeba246",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"e5b5622f0774462b\",\"/knowledge-medium/index.html\":\"e5b5622f0774462b\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CTeBIUfi.js\":\"fd347bc49e5306e7\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"ffab41a1dc13ba36\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-D9j5Amer.js\":\"d2a067e98be37e89\",\"/knowledge-medium/chunks/FacadeVFS-BiyEobxf.js\":\"7ec42203eeb673ed\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-5L_IVLUE.js\":\"f3f6eb2bca508acd\",\"/knowledge-medium/chunks/MemoryVFS-DsCXKTqj.js\":\"84a5653600f88507\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CX1FztkN.js\":\"66b317906b78ae60\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BFn1Mndv.js\":\"1adb0e8ae6d96247\",\"/knowledge-medium/chunks/Preview-DdK8_cy-.js\":\"3b51816db968f195\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Bl_9oa5j.js\":\"a6c753cc765aa39c\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C2EawjP1.js\":\"a22e4dc0bac07cae\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BAppsS51.js\":\"e143724a5462cce7\",\"/knowledge-medium/chunks/react-BQ8sfBhK.js\":\"0002b807bdfcff14\",\"/knowledge-medium/chunks/react-CAUiX71b.js\":\"98e2b4a9172ea940\",\"/knowledge-medium/chunks/react-COHsSwpO.js\":\"a5c4f240e75c4736\",\"/knowledge-medium/chunks/react-CreOsAQY.js\":\"b972d8b3e76ff932\",\"/knowledge-medium/chunks/react-DBZygtTa.js\":\"fea70793dd84eb01\",\"/knowledge-medium/chunks/react-DdD4ebQF.js\":\"cae7f02c680dbdef\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Br0ZJgI4.js\":\"623b7de766debb1c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-Dcr0fTw2.js\":\"1dd2035cf5e59e0a\",\"/knowledge-medium/chunks/react-dom-server.edge.production-ClzRHyLf.js\":\"77b6c7d62b33c954\",\"/knowledge-medium/chunks/react-dy-mDk85.js\":\"698bf580c6cc382a\",\"/knowledge-medium/chunks/server.browser-BVw79Lo4.js\":\"fe1dad604368bf6a\",\"/knowledge-medium/chunks/textarea-Y0fq8KcP.js\":\"dd1c2efab0d8f939\",\"/knowledge-medium/chunks/ui-DT6rgI67.js\":\"cb23f6908f2e0b69\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"6e87497e883561ba\",\"/knowledge-medium/src/appUpdate.js\":\"7cbb96c5277915dc\",\"/knowledge-medium/src/appVersion.js\":\"26546d2666bfc2a1\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"4c1998059e64ab77\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"763357189159adde\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"6f1598e010027f6a\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"52a70d55e2307164\",\"/knowledge-medium/src/components/BlockComponent.js\":\"3f648c96e42baecf\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"ae265c47a4eef667\",\"/knowledge-medium/src/components/BlockEditor.js\":\"e52b3b32e313aaf0\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"5b8c34c234e7276d\",\"/knowledge-medium/src/components/BlockProperties.js\":\"19aac4cb6822b357\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"1860ef2123b29c11\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"ff5f079f636ef3d3\",\"/knowledge-medium/src/components/DividerHandle.js\":\"8c4e0c9bad07fe24\",\"/knowledge-medium/src/components/DraftEditor.js\":\"e696c0a939cc02e8\",\"/knowledge-medium/src/components/GutterPill.js\":\"603b16695846536c\",\"/knowledge-medium/src/components/Header.js\":\"e56f50e39265b605\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"e77d75f223ae8f0f\",\"/knowledge-medium/src/components/Login.js\":\"0d8021c5a263141a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"9d0ba0812406e6b4\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"834f1d58eb160a95\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"72e55bfec134ac00\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ebefd6b3a6d14a3e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"7500c0b77dfa5737\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"d4d261c5e970a17f\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"f87028eb8c75a201\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"0643b811419cb738\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"43b048a8e17a56a9\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"bdfaaefaca4d786f\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"987b13a3e9fcb018\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"f972e64623b15018\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"4be0c19bef210f83\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"324e606ef2a7cae6\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"2d76f4fb51470748\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"9ffd3db180b15a34\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"8e12ee690704e998\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"c6f7cb083d4574b9\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"d1a568a16aaab806\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"5f9683346f9a9285\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"0dfd943e760591d9\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"6fbb7461134f9708\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8cc33f5682a2a582\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"6163b0c0c67f8c0b\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"513303e0c92fb7b8\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"9feb6adf0dd48942\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"716f4d83ecbc4873\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"c9d436e9b9fa3e95\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"45e9ed0d3d6bd050\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"96ef2dcc1a3183ea\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"a01f4d9f9374eae6\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"95e3a4709352a0ac\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"2c787434f4a16fd3\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"73a89f33947a5ac6\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"78b04fe6a3f98e21\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"09fcd65ec7f70283\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"1b331869bcea0eef\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"0db728cff4663a16\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"048b9b245bf8526f\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6e0234a598b5a287\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"7e4fee8a936e7f6f\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a784e9b75904f140\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"3ff99f978f142fe1\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"f217fe78bba3a7c0\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ec75aa2362d2d92a\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"898332d1bfe21aab\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"5c611358205157e0\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"514070c11ca82b87\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"c19be19f3e171b0a\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"89a19b5117d83646\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"6e82f695f5d0b0f0\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"cb1cc3ddabe358ca\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"3628b6a059d15515\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"3335f4f68b7a5678\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"1cde7448f4609595\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"a82c98e853dfd997\",\"/knowledge-medium/src/components/ui/button.js\":\"4c0c10a6fca39661\",\"/knowledge-medium/src/components/ui/card.js\":\"e99fa97cc9efe440\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"8275a835df9864a2\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"2d96f7fb538437e1\",\"/knowledge-medium/src/components/ui/command.js\":\"61169a00e048363f\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"327e1c8dc52941b2\",\"/knowledge-medium/src/components/ui/dialog.js\":\"fd8819614ba8af41\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"ecd278e757e92de2\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"696b81827f9b8e0b\",\"/knowledge-medium/src/components/ui/index.js\":\"3fb44cd37d9504d6\",\"/knowledge-medium/src/components/ui/input.js\":\"eb51bf18d1f7b2bf\",\"/knowledge-medium/src/components/ui/kbd.js\":\"c6b990815e942d5a\",\"/knowledge-medium/src/components/ui/label.js\":\"c7161d1710b1e0c1\",\"/knowledge-medium/src/components/ui/textarea.js\":\"9324223ef8193a52\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"45b44111e95b66f2\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"7ce99f6556813b6b\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"98bb434ed7bbf046\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"921819fd29dbf5dd\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"86d6e0285717c259\",\"/knowledge-medium/src/components/util/error.js\":\"b8fa9aa1c12f0c8f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"75e81daae9991ba4\",\"/knowledge-medium/src/components/util/suspense.js\":\"274dd7446c4e7fb6\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"9be542e78945e7f1\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"23abbe0f517b3e1a\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"65ae73a731aef915\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"36ae09b7f602c443\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"0850d1b2598e699f\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e532b8383c0cc883\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"476ab0559cb4aa42\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"13c1257e0775e37e\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"cde17a96d7a4622b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"3d546e1373bcf275\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"d2d4e57d55188831\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"47b7b1816184dc2f\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"011a30499c247307\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"0fd1a48d8c3576cc\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"8883f732f0ae37f1\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"a82f18957dbd7c3c\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"340402815f2c9c0b\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"b0570a3117a44d33\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"7420299c13b39fc1\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"fe81de9bd8b4e360\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"74f0b78cf2cf303b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"a85173ca767fa870\",\"/knowledge-medium/src/context/block.js\":\"0a651dee84a0056a\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"07183ca45e72346e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"2515706016427c1c\",\"/knowledge-medium/src/context/repo.js\":\"d166f0d854b502cd\",\"/knowledge-medium/src/data/aliasClaim.js\":\"c09bd46585d4f9cb\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"12dcdf8c133d0723\",\"/knowledge-medium/src/data/api/blockData.js\":\"4d897ed11d3fae69\",\"/knowledge-medium/src/data/api/blockType.js\":\"5002bf32a784675b\",\"/knowledge-medium/src/data/api/changeScope.js\":\"ab890247ccadf658\",\"/knowledge-medium/src/data/api/codecs.js\":\"27a59817246535fa\",\"/knowledge-medium/src/data/api/derivedData.js\":\"e66489ae58ab3931\",\"/knowledge-medium/src/data/api/errors.js\":\"b580fd5487c5ae8c\",\"/knowledge-medium/src/data/api/events.js\":\"e624649b69aa9dd4\",\"/knowledge-medium/src/data/api/handle.js\":\"b7668ea6455ae8c2\",\"/knowledge-medium/src/data/api/index.js\":\"8e4774d1c1cddf75\",\"/knowledge-medium/src/data/api/mutator.js\":\"8fab82d2f92fd020\",\"/knowledge-medium/src/data/api/processor.js\":\"37cec6e9fc54f0c8\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"8b383e157165f527\",\"/knowledge-medium/src/data/api/query.js\":\"b63f630a7f8b8431\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"44dd40b1dd277da4\",\"/knowledge-medium/src/data/api/schema.js\":\"b7668ea6455ae8c2\",\"/knowledge-medium/src/data/api/tx.js\":\"b7668ea6455ae8c2\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"456aad62de2cf1d6\",\"/knowledge-medium/src/data/api/user.js\":\"b047ddc9e65f6dd6\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"019a90641cfce3a5\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"3565f46eaf2740ac\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"cd296d7874af355c\",\"/knowledge-medium/src/data/block.js\":\"7108fb924e80e2f4\",\"/knowledge-medium/src/data/blockCache.js\":\"ac1795b871160de0\",\"/knowledge-medium/src/data/blockId.js\":\"590f6bf0a4319706\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ef2816469de4ce01\",\"/knowledge-medium/src/data/blockMerge.js\":\"e7591a5a0f3de2fc\",\"/knowledge-medium/src/data/blockSchema.js\":\"f0361a1738f9de72\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"6feff5f2cc61e625\",\"/knowledge-medium/src/data/blockTypes.js\":\"ad6ca1148c7e73d0\",\"/knowledge-medium/src/data/childrenView.js\":\"ba8d9f9bf1b07894\",\"/knowledge-medium/src/data/clientContext.js\":\"4ee01932af87992c\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"3f73ad9c109057ef\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"c4ed4adce2525d4d\",\"/knowledge-medium/src/data/derivedIds.js\":\"e22ca999049369d2\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"6859bc8371271bfe\",\"/knowledge-medium/src/data/facetBridge.js\":\"aa9409b165c3402f\",\"/knowledge-medium/src/data/facets.js\":\"c2608f5d1e550079\",\"/knowledge-medium/src/data/globalState.js\":\"3f94c9960af0c54c\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"17a16b558d28d62c\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"d11a533c72a794ee\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"8d091d7e9957c238\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"7a715b128721bd97\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"0e1e860d9ec8a2f7\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"6ffff430c27fc4b0\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"4066718f56c113ff\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"ed3df882211f1322\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"03e2bf878e39f1e4\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"e0f57c9c338b0bbc\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"c41cd5f5c35e14ae\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"07c13cec39553f78\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"6a2abd8f4e0c518a\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"e57feab587757eda\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"a880f5492a53e568\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"189a6f03aa62a514\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"df217d2fb1e12e07\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"1cebfc0ce3073c94\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"1514a6ad02a6604f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"f34dbe744fbd18da\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"16310282ae12f318\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"3ae5e41cb201bdbc\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"0eaa9abf96113f5f\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"108e358cc0e678da\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2e449fde6dd2e7ba\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"659bda36ca770c7f\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"bae51b77c89f54ba\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"285a976b19e49370\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"470004e69bd363e7\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"8bbe48444ca1043e\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"91e0112ab977c83c\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"67966b562840a444\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"319cdccb62e8f340\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"fb7b861114222f8d\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"4533b8896a082a13\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"f9ea2e731b7d0073\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ed19618487ae4a36\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"c312be80680eea0a\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5df50477667a3a41\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8b0cf3ca9f81a77d\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f680996acce30f1e\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"e91ff07a2bf8072a\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"a4ece254220d4910\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d788eb7229d78a40\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"56f143dacafce7bd\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"81288ec9b605e57b\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"af4cac44c9f9c2e6\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"dde337a6d5fd053a\",\"/knowledge-medium/src/data/invalidation.js\":\"910a7466dcb635a1\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"5f9c40f28d0df850\",\"/knowledge-medium/src/data/kernelPage.js\":\"bd999c82c2fc8d62\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"254287fa1e2653f3\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"6b11cfe3f83ea301\",\"/knowledge-medium/src/data/localDbStorage.js\":\"e0748ef4bf7a04bd\",\"/knowledge-medium/src/data/localDbVfs.js\":\"d4f8a25234922306\",\"/knowledge-medium/src/data/localSchema.js\":\"3b4e594b1a26901e\",\"/knowledge-medium/src/data/maintenance.js\":\"ec7b2f261aac2a51\",\"/knowledge-medium/src/data/mergeProperties.js\":\"9a6afa361d309ba1\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"10e886fd92c923e2\",\"/knowledge-medium/src/data/migrationsPage.js\":\"52d8f60a317234d3\",\"/knowledge-medium/src/data/mutators.js\":\"50b93cf95cc1c774\",\"/knowledge-medium/src/data/orderKey.js\":\"fbe91e4d1a4f6174\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"2b4e961190723e8c\",\"/knowledge-medium/src/data/outlineSurface.js\":\"100fbfc971cbceef\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"add621c24885ce17\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"663d2428d77ffe1a\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"d0bfd46004ddc8b3\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8a2bcc409026335c\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"e28f4f4630fa8416\",\"/knowledge-medium/src/data/properties.js\":\"e407d2b9186cdaaa\",\"/knowledge-medium/src/data/propertiesPage.js\":\"c1de2ab3b952bb1e\",\"/knowledge-medium/src/data/propertyChildren.js\":\"96a95fc630a9e548\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"54460d971bf36704\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"3cb12c035b109a1c\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ed9b830a2e6ede32\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"b0f9eba63464fdd8\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"2c44401068c1c87d\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"e4af974500c57644\",\"/knowledge-medium/src/data/propertySeeds.js\":\"f62efecf4332a93e\",\"/knowledge-medium/src/data/recentsPage.js\":\"e9c690c07dd899ed\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"eca40c8fd4a7f5ac\",\"/knowledge-medium/src/data/referenceBlock.js\":\"760e94110cf929b6\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"54412fab86545c4c\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"5dadd790406446b8\",\"/knowledge-medium/src/data/repo.js\":\"8dc0baaa50c4a47e\",\"/knowledge-medium/src/data/repoProvider.js\":\"f12c20f7614e06af\",\"/knowledge-medium/src/data/rowProperty.js\":\"e470c5fe36c5bcec\",\"/knowledge-medium/src/data/searchFilter.js\":\"9862c25a3a00a04b\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"22f6190dd929be6f\",\"/knowledge-medium/src/data/stateBlocks.js\":\"7456f7a1994bddf4\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"0b749fe74c5744cf\",\"/knowledge-medium/src/data/structuralInsert.js\":\"3f3b4fd4c21bfba6\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"a4824384aef0db29\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"4f8354b3f90ab3a8\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"a3ae5ea3acfff6a0\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"526c3f175a23c13d\",\"/knowledge-medium/src/data/targets.js\":\"f3ed1df961acb677\",\"/knowledge-medium/src/data/typeColors.js\":\"6806e001f3d946b0\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"b461fa16181aae56\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"adfb409fd51cca48\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f5c57f865337c023\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1672392f09224457\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"51912e22ed570432\",\"/knowledge-medium/src/data/typeSeeds.js\":\"74d50f9586c8cfbb\",\"/knowledge-medium/src/data/typeTagger.js\":\"33539b460fc712bb\",\"/knowledge-medium/src/data/typedRecords.js\":\"16e9fd70a2ff0544\",\"/knowledge-medium/src/data/typesPage.js\":\"49dd1c304a11493c\",\"/knowledge-medium/src/data/userPrefs.js\":\"0191c7040c00d343\",\"/knowledge-medium/src/data/userSchemasService.js\":\"51be832a13ab4c78\",\"/knowledge-medium/src/data/userTypesService.js\":\"f17290d6f1e8ec9d\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"67f4ec49c1895513\",\"/knowledge-medium/src/data/visibleChildren.js\":\"3b24025caaafac81\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"b8609a6132fc7461\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"201c9425bc853e14\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"10e34d5e3cf233ae\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"5ceae55a43b58f1b\",\"/knowledge-medium/src/data/workspaces.js\":\"c2538e0d574ee5ad\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"b75884812dfa182f\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"e8c564cae440a72d\",\"/knowledge-medium/src/editor/atTrigger.js\":\"4ac4a326db95b796\",\"/knowledge-medium/src/editor/autocomplete.js\":\"63161a0bb0b89b87\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"519dd5364016f9bb\",\"/knowledge-medium/src/editor/contentFlush.js\":\"0886ac4ab8d3bb2a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"ca4ba0e2ced587a1\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"e50cb49b9918a2e8\",\"/knowledge-medium/src/editor/insertImage.js\":\"584dd5de2d4303ba\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"b25c020512f7844c\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"de5c480ca3a2ca7f\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"1d04c27ec994837d\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"dcce3ea3b29d1811\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"9e74592f1287e0c9\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"2db7ff13028ebd0a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"efb36433b61bb477\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"7a2a8666ce4eb6ca\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"65a9405ce87e8dcb\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"3842103651bcc635\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"d7fc9b25699834a0\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"91d3c5909a4b80fb\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"88bd40fc2746a252\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"6b029e6388544260\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"c8c518c068cd462f\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"56abe883c25481e4\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"a9635392b61e420f\",\"/knowledge-medium/src/extensions/core.js\":\"f64dc9077a08587b\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"8d12ba00ea688e05\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"3ad1cdeb4417cb82\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"aea3adeec9549c7f\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"3206094b2a7b7fc4\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"c7caad15570e3779\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"bb98260d7f9bd69d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"29566c1e8dfaa129\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"36a157675d436d84\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"5dbf42fc3838855a\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"abb285ab522c675b\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"dcda98cf5389dae9\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"42441f6a28c5cd9f\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"f2655cc1f99f9887\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"b601dd0fd10a18a6\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f41dffe1db9337e8\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"b842c05da07d21b3\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"e953b90b074b9d68\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"22d5e1c9147e7dce\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"5b71e1e1e4b4f96f\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"d88c0ac19e21961c\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"e0ce145c7a50739a\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"f123c222ee9c005d\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"2915c2cbe77c6ae5\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"4270d520671c7aa4\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"4e042820ef65c842\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"9fe6fd2383266cd2\",\"/knowledge-medium/src/facets/facet.js\":\"d9d3350bd48c8b23\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"6f95da4f001d4b37\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"44fce543deacacbe\",\"/knowledge-medium/src/facets/togglable.js\":\"e70933fd76ff531c\",\"/knowledge-medium/src/facets/variantFacet.js\":\"d2282933f1d4c05d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"c0b972cb7cd2247e\",\"/knowledge-medium/src/hooks/block.js\":\"358ddee2af7a1d39\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"b14ddbd00eac3657\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"c4a3adfb23068fe7\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"e507f91f4ceb2076\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"84839f9030ccbecf\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"9a179ae85e3de74f\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"c56c14b6063ed3d9\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"0491294ed854b95f\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"c891b550dc5ac723\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"0b30cbf3b1ac02c9\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"1dfec0b4200ea1f0\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"0923dde5153f0fb1\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"7bf4c00c0ff57175\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"4bd3771a9198d78a\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"cc9768dea08ecd22\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"b841988405ae2c31\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"625db5659972f753\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"3659eab018b3bea1\",\"/knowledge-medium/src/lib/utils.js\":\"3b8af516cb55f21c\",\"/knowledge-medium/src/main.js\":\"0b9262ac3d80ae39\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"eb7d5a90850a225a\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"10b97d513a67b8ab\",\"/knowledge-medium/src/markdown/context.js\":\"61c2f89ac88f8a2d\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"6e711fd80adb272f\",\"/knowledge-medium/src/markdown/extensions.js\":\"bde9a322866bbc91\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"b067a4d38d46a0d1\",\"/knowledge-medium/src/minimal-editor.js\":\"5e36f0532321989c\",\"/knowledge-medium/src/paste/armedCut.js\":\"0d1f1efdbc7637b6\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"5c9a1712065bf610\",\"/knowledge-medium/src/paste/clipboard.js\":\"5b88830a69bdc771\",\"/knowledge-medium/src/paste/decision.js\":\"a03c23f0ea5c054a\",\"/knowledge-medium/src/paste/operations.js\":\"fe5b2b448b2c7ac3\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"7e725e96c521b23e\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"6ffceb1cb60fc158\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a1802b1a88135309\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"35fc1b840d7014ef\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d33b0ce622841513\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c22dedaf6c8507f1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"fad185dec64ba147\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bc6a63fb0d3de3c1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"8d862ab19633fcae\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"96ba4d88f99857f0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4ca417f7355d40a8\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"35e896fafea856a8\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5d660d85190344c5\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"ba9efbb538afec6f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"620da25af3a02c83\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"09f3196fa7ee70e6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"c009e5ccd9076665\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"669bc07dbd1ff697\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"8fe98e30a5563f92\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"3395314802aacaf7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"5ebd48c902a7998e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"1b4da7a02f859714\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4b7e865396b158da\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"3b8077361b783dd7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"b52b7a59cdd4aa15\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"58cbda3a2e1de19f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d2c09e12a1811e12\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"b58d3e11efc55d17\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"064c4e9cba6f1b74\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"cb56782a1ccd4a4e\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"1d1a31e5197d838f\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"46700d4071101584\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"bdcc96362f143c27\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"a140224a23029a45\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"e7b2c627d1b23dfc\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"232c67891f7168a9\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"7a5e6bfc1b9bd85b\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"4f229671093a790d\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"749545735f71235f\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"edf65eb7b83bf5c1\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"7a1be5e80e1b0874\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"108123fe7035db68\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"d8fb6cbc555bfe72\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"3c6e82482993f597\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"cdb7aad72345665a\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"92bc77348e973262\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"dafb8b643705da9f\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"315eaab9c37129c9\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"c7b4f2ba2d982c2d\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"01757ecca2b3402d\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"76eef92c10b526dd\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e08e7e4f269b6dcb\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"34c7a326245150b0\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"ae218ceec2a47ea3\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"6388ae446ae5f18c\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"3e8f0a870ab87dc5\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"36cf08583dd9eee0\",\"/knowledge-medium/src/plugins/alias/index.js\":\"44a8a4b04ffd99f7\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"451d18e3642f4d30\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"6505f705060fb0fd\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d8abb32b8b637390\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"ab46ee53da0d9718\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"8bb08dfbdd0993a2\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"126919fe90da1847\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"3898a7df799e4773\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"dbd6bfcea1c2a9ee\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"9c4088e40a4ece88\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"0d3d01e366e35db2\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9b945ec6d1f5b2be\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"3f86d238e522ab05\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"4ca938b2a90c6620\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"2029b5ed8d1f0f61\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"f35179152e2e7cca\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"43a3332656cda718\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"3bc6048720739ee5\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"8d9f149397ce23d4\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"7a8b8335b71d91b8\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"b8e3dd82159c880c\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"38e22ade6a05addc\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"f83772e36bf119aa\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"11d94689728e57bf\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"65662a44437fef99\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"955df60796b08328\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"016a7161c808ec74\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"954a811d06303060\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"5cc634b3406e6f9c\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c4dd4b0942f1e27c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"c5b14f3631c66a63\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"fc77a710edde771c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6246dc64fe1bf0e8\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"979ddeda439ee448\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"3f6863e7e65430d6\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"4fa0a8102116433f\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"f3b75f7d443df3a7\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"fb9afa6f60252748\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"5b2469d65880e3ec\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c4e8ed9b04868455\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"bc5530c960316385\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"6286fd7cec977970\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"f167f76644de52ac\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"93aed2cecad565fc\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"b783263370eec789\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"2318841678dc06df\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"41a442b6f65c228f\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"38f345e928f7577e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"c4017703075d6f10\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"701f198a17241897\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"f4eb7cc0102176c4\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"25df3d5c9737bad2\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"2f1c109d25e430a6\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"b8ad78be329df303\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"19621c65062fca5e\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"431ef2ebbfb6b893\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"5fb48af07be25817\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"28f09b699d808513\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"cc8ed13169dfef14\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"b91b795854ca32e7\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b4b50271f278ac3e\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"fdc1112592d93350\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"cc9089d65641ab31\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"05bf8119ae4f9cfa\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9dfade70b9eed2e8\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"9335f5a67c995ded\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"2c2ddd3e10851f43\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"15c161f14e3e9360\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"6860ae7edaf80cdc\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"2a92bd83ed7cd1fc\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"068a669ed9830433\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"b9b93557936e9886\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"d261d5d8b3707242\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"1c03d78d6a76d1c5\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"40384781c2805c16\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"e14d05921ebe97b5\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"20db97f3356db2f0\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"26bf3bb5a65270d4\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"f979cd1327a77433\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"80434f4f1041f922\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"9d72691a5a9824de\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"ba000604ecfff7c3\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"9af1eb4e10e1156c\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"7065d90ee2f272ac\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b6d83777829b3e57\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6b9f91fb61d4a5d0\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"29eaca61d4fe069d\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"39ddad23558a0d4b\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"a61e46208f09d26b\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"572d0ab21c5fe610\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ea906319dc433731\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"052e64db614fb45c\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"cb65d5298d3b15cb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e28b289fffa845d7\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"edc9fd5196603f13\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"67321f3363b6b2ea\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"157e6ecb49a9c21a\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"d3608ff6b8380e5a\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"67a7ebe99c5d1d59\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1c7efc0809d21d38\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"8099c089b4c2d235\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"895bebe9e3cf56e5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1eb20852141086b0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"776c78454d3f158d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e67cd07f158c71fe\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"23de1829091b8530\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"aba7bbbb3fd063d4\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ee16e1b4d82d7bff\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"346e9947d00dc0d8\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"b13e04eb03d1201e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"563cb5e8f47e2f18\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"ac49c0526b0e8ab6\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"1560bf427317d89d\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"86c9d45db620edb1\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"034c4f881d13f7ab\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ff065f20b45be07a\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"0811d7cc02e94041\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"0d0c466571f66aaa\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"147b5c5558892215\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"2acaf8435ebac3b3\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"cde512417d29b459\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"a43fabb6d0523998\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"bdbbc7b2555ec93c\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d421187dd29994f8\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"04b362f666d87ea9\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"3f8d675e369d846c\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"a0bb2ec27d4cdcb4\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1c1a11a19251b787\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"564c7fa6d394fcf9\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"ed39f397764fb1c0\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"c78c69d2d3594d90\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"78c7009a90923f4f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"0d89b9a9ed5c7d6a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"a2ba36360061e11e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"cc0212fd7c4e66b3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e1f35f2e5e3420a9\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"264699ddb47e92af\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"563770bcae173579\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7d4a85037ad0fb02\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"792b35300ead0d45\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"7c7f0ed19476a11b\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"538d2cffbacb734c\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"07b37c86cd1e12d6\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"66532240b3a731c5\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"668a1531ec54418b\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"6ee5a2ef8069ef8c\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"7dd4e459d7c35e27\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4570a887fe4b6025\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"365c1f944a06dacf\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"df2cdb6adbff8acd\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"3b88a9dc31fc8a70\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"63f14a0238a3aaf8\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"0bb54e3c46a05d73\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"353f98de293dcf09\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"0e92ce2931570afc\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"7978a2d881ac0f0c\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"5b16c2fdeff101c9\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"fb1004e011eb2257\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a6e8b35b3590dfef\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"2c42a379ee859097\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"0ebf4e7ac815d840\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"6464dadbd064bd24\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"b923a6241529fe67\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"53293a6f76d79bce\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"dba5c0d483cf5377\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"cb4fa6e0d165da4d\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"ad1ac8244794e2ed\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"bcfdfc12c087676a\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"9cfd3568dc829d64\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"657e9c6caf03b422\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b5da15f2220d7760\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2a2fafd25a8470e3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"384a496ca669359c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2766b36edeb7425b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0b1124e98a13b7b8\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"4b1fb91f5b95ccda\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"ffcab34f70e69072\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"83a68d06041a7b90\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"83334ccd892a271f\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"38cb8bd2b53e6738\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"32919e2c09492220\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"2b65f4e60a559327\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"796f2ba7f5276c24\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"703053a6c370a9b4\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"a804ce7c3a80f2ff\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"afb16db480f63c09\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"fff61812e1e69b4f\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"39e11048efaaa367\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a4e25713d49135ae\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"19f8e3d17562fccb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"b73b0890e45abb68\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"eb9ad151f470aa90\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8945a39b79fd83d6\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"7486b825e7b69985\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"2e4186a1e7b864ac\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"099e3aadb09be3f0\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d5fe3be686537d3a\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"d15a3cb2d520e3c8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"8d0518a629734cf7\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"cb60bdb6ff7f986b\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"359c0418ae4c3833\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"4cd5693029c866e9\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"b0f977c93e1c41ed\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"d09ceddc2841e873\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"1d72eebc5a5b3f8c\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"26164ffc93567136\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3ae2510c9ab4eca4\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"6d9c4a5b221e2aa9\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"86cbcc900fcb540f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"10a9dc0a51414ef8\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"deb46eaa6b42ef17\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"2cd1fe1c7f39c058\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"cd81a35584731576\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f3db05619dd5853a\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"05f66c3652e4999b\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"fee0bb292c3f51e1\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"d572e6832c4ea348\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"2d42f39390cb95b8\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"1590dad04d4eb7bf\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3adcb6ddc52da9c1\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"d424d7f04535f298\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6c7704320bbccfd2\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"bb70418701d49b34\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b5341b51ef42add2\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"de94b44e513432db\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"2d7e67a6688b5cd9\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"222af7af914bd4dd\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"8ec0538c948f989f\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"09b13dc99af75ca5\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"21b713c1add8fe82\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"eb6f1b004e8072f7\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"c4f3d01337fa4612\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"54c66676432d3000\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"6e6ddba69852391f\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"2877f7d97d078c3d\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"c623310288e19269\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"9e4edf5c913ed349\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"5165297dd014b4f3\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"ea777494c3d0ac8f\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"b08051b355f059e1\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"2f922dab3da1b5d3\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1bcdcc4dca8f968e\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"feea2e5ebcabfe3c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"7084c460f8f2eb05\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"7be8f05f119bc006\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"4af15de3253ebe0b\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"0d2b4c03695c0db1\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f4a91a8ae5e01dbe\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"dac32f16b5958392\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"e2d977efbda6136d\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"7af1f15bdc937a71\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a4a5229ae805fb56\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"880fe0790dd7d06c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"c3961bdd67d7beac\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"e17318c36aa87450\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"afa15d12d4a02ed7\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"c35f5d378ee3bd9f\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"99b6e22918418ccd\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"255e7b4ce988ed7d\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"5a2b4c9ae18db1ee\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"d3177634fafe3da2\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"83f73be4c66e29f9\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"ad503b7a730889bb\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"2eb6a7628b16c88f\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"1e0f84f83c3f8294\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"582f66627b4e8e63\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"9663ce33faedcb32\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"820f5e35b9a33b94\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4687778bc8a9e34b\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"8c1ed72bd6399773\",\"/knowledge-medium/src/plugins/geo/index.js\":\"477fd40815468e04\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"5b9961d2ee2027d7\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"1e3cfd8a2d9d0f26\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"ffbb7e2565fca8fa\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"538abd90b8dc3c44\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"901827c693d6989b\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"7a96ec2babcebd51\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"717e23da2095e41b\",\"/knowledge-medium/src/plugins/geo/query.js\":\"d6530970699dd95a\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a28c841cc60d34e1\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7f581cea2e2511dd\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"27cd5d44c875911f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ac264249582b577d\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"b8108b2e2b174885\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"9745170314afcf97\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"645a011625c5857c\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"c8f1a651810aac90\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"9b6df461a00a0d2d\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7e6bfc03a6110262\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"01f4f45ef64f99be\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"27c8e558a029b973\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"015f1abe836395a2\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ba9aa00a79e99afd\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"e826151a0e300db2\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"f9837cf15b57eecb\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"9d22b670e9fc183e\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"d30a994e93a7e13f\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"27eea05bdfa46718\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"45e7dffb1ee57d21\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"d7742981ddae951c\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"e807c3553a434618\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"20c8dd2a71db3bb5\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"8a89981c328f8bbf\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"4fe99c073f538e05\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"9ef269bf0482b388\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"b73ed1e29e0af171\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"4bc91812e9296d1d\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"26e1665f4b37d72b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"80d2653dcc08d2d2\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"144367b8c0eacb5f\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"16127391172bbbf1\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"9033464052ce5121\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fb05eabd6078f3fc\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1b78556d59972321\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"90857e2ecc171aab\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"4ce940c2c7e9400a\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"0e5b8b3c81739056\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"9553adeb1a084eb2\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"866e188043dd7bbb\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"045e0ae26c5a66ef\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"d718d3c2d5fdb453\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8de6a3f1cf61332c\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"15f4b723de702c6c\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"7d4c59e90b0ef969\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"35eb8ec2bac88061\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"da1a7682e484de9d\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"466c784b8d57867c\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b5ae8b98ad525f45\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"78931074b4be5404\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"2afe3d0091df2a81\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"dc1bceb071d61a06\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"d35bdf6dc8db7ef7\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"73455adabf318e11\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"1109e68c6837295f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1cb5f64c4f6def9d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f3967077a0ad2f1d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"d8396ff7f3f2b6c5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"eaa7a06c4a22b26c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"39064a127b1b5668\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"57a9a1f62caaec4d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7aff59b6ca2e1410\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"eae3cee721e23d01\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"58ef5bba2ee38f0d\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9b4d53516d377e52\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2a9f128f11543a34\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"bf164c79d2f59864\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"81e46c419e5380e8\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"b67b8b4e9e99790f\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"69a53b0cb8cf8efb\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"30c4b8021a4e0cf6\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"a0734f90184dc33d\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"0960dc1f7278a0c6\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"01be706619c84817\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"f53a17a0942aff8d\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"ebc23d356f562c2c\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"3cbc7da32d195d9b\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"1c634463b8c6df78\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"4f3cba8b190eceb9\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d9b820424664ba78\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e69b01d3c88aef90\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"3199fffc7d7a07e9\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"311f800357297a8f\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"fdbc90090687e075\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"b466fd4205b06cc9\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"5c4924f3c87e1f1d\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"282c8bdd1bbae4e8\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"7fbeffd352a7c480\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"3b30813847c522fe\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"57e27b919ba30af5\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"b0ee5e139737323a\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"0c1e3b99e3587c26\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e4217c4cbf5990d5\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"e8ca0c9f1bd5f5b6\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4d87da62dadac31a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"57c855d61ca4bfb8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"2725fa33eb591fc7\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"ca7f6aa30755842a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c33c0af0460faf1e\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"de2523a40ad0548e\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"0c3bba43646dc72d\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"34b6a3f7fdebe1a6\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"4f7a4e03113a4caf\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"9c465e957fbea476\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"5d1d7e358c6de292\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"81900e19edb31e02\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"30475ff8347b86b3\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"cfde636e34c93a80\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"17390590fd332772\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"fec2f11921da32df\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"1528ea7b7a3c3f97\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"48e13ee05f4aef80\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"5280cd6531278c2a\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"8fd126efb714c88c\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"b2362dfe778c9299\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"12bea721bc503b42\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7c9f6bb5ec01e91b\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"5db45be81406fcb8\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"04d2537a40f991f6\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"60ad247c0ea331f9\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5952980bcb6006b0\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"ddd3bea3c9d98973\",\"/knowledge-medium/src/plugins/recents/index.js\":\"f6c551a9cdb06676\",\"/knowledge-medium/src/plugins/recents/target.js\":\"47720f71dd95ff31\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"1b7220a3df74b88b\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"8ee6857123951aef\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"26d77661bb52b6ef\",\"/knowledge-medium/src/plugins/references/index.js\":\"2cddce42cb28a6df\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8d5828be2514a40b\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"986639cf42f5251f\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"6dc4e2fdecdfe9d3\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"114d859e2909e54a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c1d280962abcb53d\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"2a59155cd16869e6\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"00a49914ce6cffc3\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3a61a55c1d6f2101\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"0946696f63afb847\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"78644928e18d0d60\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"9ce53c59b0d322fb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d5945d161a62c57d\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"eaca573dc87234b0\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"07f351d10282bb1c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"98faaa9d5c437255\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"894e61cfedf8b863\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"74963cb348a2d311\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"174ca1249b6259c3\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"93cef094f1c65141\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"8eac768693ce9104\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"0cac0d48e3104400\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9442ce74bfe36e06\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"2d292617c74820df\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"3670e17aa5d6d6f1\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"88a3d596555aa28a\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"3a5783681fa45102\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"1cd583338e58abe4\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"999c17246eb51da5\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"c7deb97cf168c081\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"7eb94c9e378c3d66\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"f8874ff99b95dae2\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"e08c09ff8cfa8bc0\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"445f88e16bc72b68\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"fe930afb2ad5c2be\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"3fa7d5c4984e7b0e\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"3edb7033d47ca5e4\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"0daa40d48469b76a\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"56b4e9b96fd636b7\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"f3611a37ec85d2e6\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"0e75e2a8d0e7bf2d\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"9abe19b8e8d14e48\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"c16243a4516d3d2a\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"9d6f8ce2108dc44a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"410fc9b5be40fab3\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"66a9d35a2850dcc3\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"97bce48d534effa5\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2587290314e1ba0c\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"973d3d5220ec113a\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"9e83ee5553bc1f7e\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"54d41cea3ebf342c\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"2f45942f7ddfda94\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"14c411ed2c03e107\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"c9a9dfa60dff45e7\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"37daed7d0fa348f5\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0b9e0ecdbc77c3bb\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"8a93b4b6a6746c6c\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"d6e062c4925c9413\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"b6de2fc4d4545528\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"1f2c6db9f2a66e50\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3f2c9e4f5882567e\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"264a7ffb729b9abb\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e60a320e800412f2\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"bd8dcfa3de2d9d6e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"fcbe24ad3ab7dbfe\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b16d20f2ed5bd334\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"458e70b738350772\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"71d5f94fdd80a131\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"65d724301d3b0d10\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"bd99d0fa66b988d3\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5b7d42f4d469e7fc\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4d0fe0882f18d55a\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"b028c3a0db19d5d7\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"7abaf63a527a33ba\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e4b8312c449c8861\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"cd0615af8fcdb980\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"cdb3bd717245e125\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"115897de0f95c06d\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"8a4042c697e0a31b\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"ce6fb1faf6de6713\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"0e1f395ea4d1bc81\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"db113f2ecfb1fa90\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"851baaed958529df\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"dff9f0a325cf7722\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"c008df7dd5b92ca7\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"1e078faed8056a0f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"54712ebf9f7ba280\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"d3f0dd7a38539505\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"38a298adc2ffecaa\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5fd323d342231b2d\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"654e7e98869bbb54\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"73cd6a64949a043f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"50fe69f296a8e7a2\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"2567d2bc4362d755\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"a6d2cce43a0be58d\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"37776d3ed397a907\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"2a76484471a640be\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c7184885dfe1eaed\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"aa46a5de9c2a5608\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"e09f8a7f7a8bc45d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"a7562ab241730998\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"d1fd5c45875de4bd\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"343f2a1068290a27\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0995522dba59d128\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"e165d4d10b5d157b\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"d820e434e7e82138\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"cd534402671454b5\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"a95f99d5c7595985\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ea3ca019e770a7c7\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"b2d3d75d53620fe3\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"55442f1e49fbcc55\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"a973ad6ca6fbfa52\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"e049ab091b64e4fb\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"487dfafb40e9ccf1\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"1d96375cdd877e81\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"dbb40e67666eb170\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"65e895a8b5cad3e2\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"94a1aa67dfae1380\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"9ef77cc3658ebf78\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"6175eed57c7abbb9\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"cb47b87ed2d9d055\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"927105d3bd24d0a0\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"79806c4cd3e3a586\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"8bec09dc49929289\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"03bc036f4034489b\",\"/knowledge-medium/src/plugins/tables/index.js\":\"41b65cab3a892a86\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"a0d60854f87abdf3\",\"/knowledge-medium/src/plugins/tables/model.js\":\"49c69fdad53e82d2\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"bd4af001b6982c29\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"6e370eaaedcb817b\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"0138703c2faf0d79\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"26599133d9949c96\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"d44d12196364626c\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"c678c22140d59fe3\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"5f6048f1b9021315\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"33f9f802e57f9462\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"fe20b7a81e869c5d\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"99dd0b07a1b1f1cc\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"d07a418a425f20d5\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"45d55fcf18be0acb\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"23655c82ffbf35c0\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"2dc1bd7b2a0b855b\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"eb953ba539d0dd5c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"05a8d39bc41cca54\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b183b4c93efcf703\",\"/knowledge-medium/src/plugins/todo/index.js\":\"5e7435cc833aae8c\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"8143bfcdc5209d32\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a93080ead051a96c\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"fd6addf95dc7a14e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"4bb2e2563242b5cb\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d1d835d9bf240d11\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"51d932ecfb672d16\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"382820bd705cd460\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"c285059e4491a41e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"abbd55026514af07\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"b599bd3820e953aa\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"d8ade64e9a8c68b6\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"5b5375be30251291\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"6a12d23a778a610f\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"a7100416efade21e\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"bd119edf6aeaab55\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"8092068f005abc80\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"c23c961759fe5101\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a19019af621e97c9\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"1cd60292a895840e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"cd629f292403adca\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"7448db8aaf611663\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"5e5a2930fc95ad18\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"cccabd753e1ba7cf\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"d128559a69c1acc0\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"47f0bf9c8282a189\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"a2081f3a93b4a9f5\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"ac394594d20ce568\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"d3fe701d98194b39\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0ba21cdb2165c3a2\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"86295ccdfd87afcd\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"f5018b7017309ee7\",\"/knowledge-medium/src/services/authStorage.js\":\"e5657aa74e65cb55\",\"/knowledge-medium/src/services/powersync.js\":\"8c289e3105ca3e02\",\"/knowledge-medium/src/services/supabase.js\":\"c6593d0a906f5797\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"c23c995dd832a351\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"f9ce01cd693019c0\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"05ac86a24d37aab8\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"330d0c3c3d03b664\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"6682faecb9cfd84f\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"e0bc242f1a113cc6\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"cdb77051bbe33499\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"7c3cf0c80fef9125\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"430e378c48186c6d\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"7a6c3013eea5bd0d\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"fdf927417953acd2\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"fd145b648647e1b2\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b0ccccc14b201008\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"19d5b4339a98f25b\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"e6341c3409db4988\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"2eb1f03d6486226c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"601b4643f02364aa\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"d7b3b9499575678c\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"bfab0d6b815dca2e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"b93b415675526b73\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"f35155a12d3f4b9a\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"8849557442cf94e2\",\"/knowledge-medium/src/shortcuts/types.js\":\"f104c0944cb2d0ba\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"74572db102dfb31c\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"87d3b2444ce11220\",\"/knowledge-medium/src/shortcuts/utils.js\":\"261e6f313ef77a40\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"0f3815241caefc24\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"ca868411dd15017f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"94cd74deeaa6b0bf\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"18649fa1ee4e3552\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"0acc913b6d7b4d52\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"49ed8ffac067b742\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"b3d368538ad5b5b8\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"3a443ce55316cd2c\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"14d8459ff9e81d66\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"2eb606645482869a\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"6d1f0e18d4cf972e\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"e188ce755c2650d2\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"516174c49eb4fc27\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"54bfd27abce2c508\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"fb89734746ee4c5b\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"dedcd9a0b6828845\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"dfdd1ea80646c7fc\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"62b8302d87a277d4\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"fbbc55d024ae93ce\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d153d195d794ff34\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"032cc3822dd44e34\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"4f3a52d37a2950a5\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"948e6fc3faca777c\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"5af87f027290ffb2\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"83bdb958b394bf55\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"1bd868c387c88457\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"705c4d296446d9f8\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"ad454e975802e32e\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"946091e632bba36f\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"01d50c135762afe7\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"afc7ba43c4a95266\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"4869db2e10f40242\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"25b152cc22aa11b9\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"1bc550b67d88e5e0\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"463d19473a1bc3f5\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"6cd87bfea053c5b2\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"cfa4ef00044c0fff\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ea6822cd4d31b164\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"b476cbbb7f612d3f\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"231becb3de226f47\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"44349adf1d7e1555\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"497c5939e5588456\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0c2d62a4cbdfbe87\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"0779ef638485e3c1\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"f2a4ae248413205f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"09f8eee40704b225\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"629fccf7226ce416\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"48246720390a0dc1\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"5967be0ecfaa01d6\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"bdbea836124581c2\",\"/knowledge-medium/src/sync/transform.js\":\"c75b501aa38188bc\",\"/knowledge-medium/src/themeBootDefaults.js\":\"71d252e3f5301805\",\"/knowledge-medium/src/types.js\":\"7bb54aa8cd8dabd5\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"815983311b590c8d\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"a0ed3a518b117e3e\",\"/knowledge-medium/src/utils/array.js\":\"e5181a2ed8d50514\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"9b9905c7f5c56cd1\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"6ec863f1db70793b\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"7fab083b02d43ec2\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"e32dadbe1c084902\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d60cdca821061143\",\"/knowledge-medium/src/utils/clientId.js\":\"feea28a10893dfa5\",\"/knowledge-medium/src/utils/codemirror.js\":\"2eb6fc885e8fc2c9\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"0bb289274234f019\",\"/knowledge-medium/src/utils/copy.js\":\"1b5bb9d71fb50b8d\",\"/knowledge-medium/src/utils/dailyPage.js\":\"19535a6f431abc8a\",\"/knowledge-medium/src/utils/dbForensics.js\":\"bd7b8fd054d8e3ed\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"143157b754d615fe\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"72885b34ed19efa4\",\"/knowledge-medium/src/utils/dialogs.js\":\"a47faa7eb31b670f\",\"/knowledge-medium/src/utils/dom.js\":\"dddd238c28a72984\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"eed851f89992e6aa\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"6addbe0c886ba848\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"fd52ce88ff7d8be2\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"7d200b0f67ed552f\",\"/knowledge-medium/src/utils/flipSlide.js\":\"bd098cb5b8b252d6\",\"/knowledge-medium/src/utils/fnv1a.js\":\"c03e6e6a33d41729\",\"/knowledge-medium/src/utils/formatBytes.js\":\"5b67abb31b6924ff\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"bab5ed60a5f18260\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"b157c81707f2c374\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"325efb68b5617cf0\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"f4ce153ebf5679b1\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"77129b9672909b78\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"c33076df4fa4d11f\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"6ce43ba57bde2ff3\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"efceb9795c07c36c\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"e379ca6dc9dd45e7\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"9579882028d69c87\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"915fb09f56e1dea7\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"ee53f96dba2dfd89\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"23b2e7099a665b5e\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9348cc031a11713d\",\"/knowledge-medium/src/utils/memoize.js\":\"90b56ea566a6d6f3\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"1aad887901e0f442\",\"/knowledge-medium/src/utils/nameList.js\":\"43d5e6f4733142b2\",\"/knowledge-medium/src/utils/navigation.js\":\"e95080f9931cfbf4\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"2a3c756b053d06f9\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"2ecedd9633bb28b6\",\"/knowledge-medium/src/utils/panelClearance.js\":\"2d6dbf642bc7efc0\",\"/knowledge-medium/src/utils/panelHistory.js\":\"4121b0a50e10e33e\",\"/knowledge-medium/src/utils/panelLanes.js\":\"af9f8aead4c2317c\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"9913a705207f37d9\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"7ff18d2125d7f617\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9e583addd408d5e7\",\"/knowledge-medium/src/utils/platform.js\":\"36b72afa033ae3bf\",\"/knowledge-medium/src/utils/pluralize.js\":\"f8178da622eade67\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"f618c5ad402990a5\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"434372e8a7844df3\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"b6c7b5e0c856788e\",\"/knowledge-medium/src/utils/react.js\":\"caee5cb2ff34cba7\",\"/knowledge-medium/src/utils/relativeDate.js\":\"278508c84269c8c9\",\"/knowledge-medium/src/utils/relativeTime.js\":\"287d0f713f67bdba\",\"/knowledge-medium/src/utils/renderScope.js\":\"1e8686ebba309070\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"5e5f08f837154d21\",\"/knowledge-medium/src/utils/routing.js\":\"e640f4c21652b026\",\"/knowledge-medium/src/utils/safeMode.js\":\"1c4be48fda48d443\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"56c41a9726dc54ff\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"bc358ba211e889d0\",\"/knowledge-medium/src/utils/selection.js\":\"64d8e8340c5cefdb\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b6f331505dc12034\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"e4b2088608979355\",\"/knowledge-medium/src/utils/state.js\":\"477fa6c3100bc921\",\"/knowledge-medium/src/utils/string.js\":\"513405fa474bee19\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"de0b2c8e4043dc75\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"4d068f9b48f26bcb\",\"/knowledge-medium/src/utils/toast.js\":\"d517d06a675a98ba\",\"/knowledge-medium/src/utils/toggleStore.js\":\"493850a8ed2670fd\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"13a8c6045bc845ab\",\"/knowledge-medium/src/utils/userActivity.js\":\"0dbeb0ac85da2698\",\"/knowledge-medium/src/utils/viewTransition.js\":\"2558dd29a54b9435\",\"/knowledge-medium/src/utils/viewport.js\":\"2e981fbdb5e6b030\",\"/knowledge-medium/src/utils/webLock.js\":\"47cb28c1a27c78ed\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"f5c117e87d7f45ca\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"34fb702522d25313\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"be56acf24c5d5d29\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"45008524926a355b\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"d02dbf8c733f54a8\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a4a86e7281bee8e2\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"02504efe98170923\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"8b8729ce6476b742\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"3fb0d7209cf37f0e\",\"/knowledge-medium/src/vendor/react-dom.js\":\"f4993a353669a021\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"b53df3ed361c6cb1\",\"/knowledge-medium/src/vendor/react.js\":\"35385ba7c75ee314\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
	}, {
		caches,
		fetch,
		origin: self.location.origin,
		now: () => Date.now(),
		storage: navigator.storage,
		indexedDB,
		mark,
		bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : void 0
	});
	self.addEventListener("install", (event) => {
		event.waitUntil(sw.install());
		self.skipWaiting();
	});
	self.addEventListener("activate", (event) => {
		event.waitUntil(sw.activate());
	});
	self.addEventListener("message", (event) => {
		if (event.data === "SKIP_WAITING") self.skipWaiting();
		if (event.data === "BOOT_MARKS") event.ports[0]?.postMessage(bootMarks);
	});
	self.addEventListener("fetch", (event) => {
		const response = sw.handleFetch(event.request, (p) => event.waitUntil(p));
		if (response && event.request.mode === "navigate" && !bootMarks.firstNavReceivedAt) {
			mark("firstNavReceivedAt");
			response.then(() => mark("firstNavAnsweredAt"), () => {});
		}
		if (response) event.respondWith(response);
	});
	mark("evaluatedAt");
})();
