import { slug as githubSlug } from 'github-slugger';
import matter from 'gray-matter';
import type fsMod from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, ErrorPayload as ViteErrorPayload, normalizePath, ViteDevServer } from 'vite';
import { z } from 'zod';
import { AstroConfig, AstroSettings } from '../@types/astro.js';
import { AstroError, AstroErrorData } from '../core/errors/index.js';
import { CONTENT_TYPES_FILE } from './consts.js';
import { astroContentVirtualModPlugin } from './vite-plugin-content-virtual-mod.js';

export const collectionConfigParser = z.object({
	schema: z.any().optional(),
});

export function getDotAstroTypeReference({ root, srcDir }: { root: URL; srcDir: URL }) {
	const { cacheDir } = getContentPaths({ root, srcDir });
	const contentTypesRelativeToSrcDir = normalizePath(
		path.relative(fileURLToPath(srcDir), fileURLToPath(new URL(CONTENT_TYPES_FILE, cacheDir)))
	);

	return `/// <reference path=${JSON.stringify(contentTypesRelativeToSrcDir)} />`;
}

export const contentConfigParser = z.object({
	collections: z.record(collectionConfigParser),
});

export type CollectionConfig = z.infer<typeof collectionConfigParser>;
export type ContentConfig = z.infer<typeof contentConfigParser>;

type Entry = {
	id: string;
	collection: string;
	slug: string;
	data: any;
	body: string;
	_internal: { rawData: string; filePath: string };
};

export type EntryInfo = {
	id: string;
	slug: string;
	collection: string;
};

export const msg = {
	collectionConfigMissing: (collection: string) =>
		`${collection} does not have a config. We suggest adding one for type safety!`,
};

export function getEntrySlug({
	id,
	collection,
	slug,
	data: unparsedData,
}: Pick<Entry, 'id' | 'collection' | 'slug' | 'data'>) {
	try {
		return z.string().default(slug).parse(unparsedData.slug);
	} catch {
		throw new AstroError({
			...AstroErrorData.InvalidContentEntrySlugError,
			message: AstroErrorData.InvalidContentEntrySlugError.message(collection, id),
		});
	}
}

export async function getEntryData(entry: Entry, collectionConfig: CollectionConfig) {
	// Remove reserved `slug` field before parsing data
	let { slug, ...data } = entry.data;
	if (collectionConfig.schema) {
		// TODO: remove for 2.0 stable release
		if (
			typeof collectionConfig.schema === 'object' &&
			!('safeParseAsync' in collectionConfig.schema)
		) {
			throw new AstroError({
				title: 'Invalid content collection config',
				message: `New: Content collection schemas must be Zod objects. Update your collection config to use \`schema: z.object({...})\` instead of \`schema: {...}\`.`,
				hint: 'See https://docs.astro.build/en/reference/api-reference/#definecollection for an example.',
				code: 99999,
			});
		}
		// Catch reserved `slug` field inside schema
		// Note: will not warn for `z.union` or `z.intersection` schemas
		if (
			typeof collectionConfig.schema === 'object' &&
			'shape' in collectionConfig.schema &&
			collectionConfig.schema.shape.slug
		) {
			throw new AstroError({
				...AstroErrorData.ContentSchemaContainsSlugError,
				message: AstroErrorData.ContentSchemaContainsSlugError.message(entry.collection),
			});
		}
		// Use `safeParseAsync` to allow async transforms
		const parsed = await collectionConfig.schema.safeParseAsync(entry.data, { errorMap });
		if (parsed.success) {
			data = parsed.data;
		} else {
			const formattedError = new AstroError({
				...AstroErrorData.InvalidContentEntryFrontmatterError,
				message: AstroErrorData.InvalidContentEntryFrontmatterError.message(
					entry.collection,
					entry.id,
					parsed.error
				),
				location: {
					file: entry._internal.filePath,
					line: getFrontmatterErrorLine(
						entry._internal.rawData,
						String(parsed.error.errors[0].path[0])
					),
					column: 0,
				},
			});
			throw formattedError;
		}
	}
	return data;
}

export class NoCollectionError extends Error {}

export function getEntryInfo(
	params: Pick<ContentPaths, 'contentDir'> & { entry: URL; allowFilesOutsideCollection?: true }
): EntryInfo;
export function getEntryInfo({
	entry,
	contentDir,
	allowFilesOutsideCollection = false,
}: Pick<ContentPaths, 'contentDir'> & { entry: URL; allowFilesOutsideCollection?: boolean }):
	| EntryInfo
	| NoCollectionError {
	const rawRelativePath = path.relative(fileURLToPath(contentDir), fileURLToPath(entry));
	const rawCollection = path.dirname(rawRelativePath).split(path.sep).shift();
	const isOutsideCollection = rawCollection === '..' || rawCollection === '.';

	if (!rawCollection || (!allowFilesOutsideCollection && isOutsideCollection))
		return new NoCollectionError();

	const rawId = path.relative(rawCollection, rawRelativePath);
	const rawIdWithoutFileExt = rawId.replace(new RegExp(path.extname(rawId) + '$'), '');
	const rawSlugSegments = rawIdWithoutFileExt.split(path.sep);

	const slug = rawSlugSegments
		// Slugify each route segment to handle capitalization and spaces.
		// Note: using `slug` instead of `new Slugger()` means no slug deduping.
		.map((segment) => githubSlug(segment))
		.join('/')
		.replace(/\/index$/, '');

	const res = {
		id: normalizePath(rawId),
		slug,
		collection: normalizePath(rawCollection),
	};
	return res;
}

const flattenErrorPath = (errorPath: (string | number)[]) => errorPath.join('.');

const errorMap: z.ZodErrorMap = (error, ctx) => {
	if (error.code === 'invalid_type') {
		const badKeyPath = JSON.stringify(flattenErrorPath(error.path));
		if (error.received === 'undefined') {
			return { message: `${badKeyPath} is required.` };
		} else {
			return { message: `${badKeyPath} should be ${error.expected}, not ${error.received}.` };
		}
	}
	return { message: ctx.defaultError };
};

function getFrontmatterErrorLine(rawFrontmatter: string, frontmatterKey: string) {
	const indexOfFrontmatterKey = rawFrontmatter.indexOf(`\n${frontmatterKey}`);
	if (indexOfFrontmatterKey === -1) return 0;

	const frontmatterBeforeKey = rawFrontmatter.substring(0, indexOfFrontmatterKey + 1);
	const numNewlinesBeforeKey = frontmatterBeforeKey.split('\n').length;
	return numNewlinesBeforeKey;
}

/**
 * Match YAML exception handling from Astro core errors
 * @see 'astro/src/core/errors.ts'
 */
export function parseFrontmatter(fileContents: string, filePath: string) {
	try {
		// `matter` is empty string on cache results
		// clear cache to prevent this
		(matter as any).clearCache();
		return matter(fileContents);
	} catch (e: any) {
		if (e.name === 'YAMLException') {
			const err: Error & ViteErrorPayload['err'] = e;
			err.id = filePath;
			err.loc = { file: e.id, line: e.mark.line + 1, column: e.mark.column };
			err.message = e.reason;
			throw err;
		} else {
			throw e;
		}
	}
}

export async function loadContentConfig({
	fs,
	settings,
}: {
	fs: typeof fsMod;
	settings: AstroSettings;
}): Promise<ContentConfig | undefined> {
	const contentPaths = getContentPaths(settings.config);
	const tempConfigServer: ViteDevServer = await createServer({
		root: fileURLToPath(settings.config.root),
		server: { middlewareMode: true, hmr: false },
		optimizeDeps: { entries: [] },
		clearScreen: false,
		appType: 'custom',
		logLevel: 'silent',
		plugins: [astroContentVirtualModPlugin({ settings })],
	});
	let unparsedConfig;
	if (!fs.existsSync(contentPaths.config)) {
		return undefined;
	}
	try {
		unparsedConfig = await tempConfigServer.ssrLoadModule(contentPaths.config.pathname);
	} catch (e) {
		throw e;
	} finally {
		await tempConfigServer.close();
	}
	const config = contentConfigParser.safeParse(unparsedConfig);
	if (config.success) {
		return config.data;
	} else {
		return undefined;
	}
}

type ContentCtx =
	| { status: 'loading' }
	| { status: 'error' }
	| { status: 'loaded'; config: ContentConfig };

type Observable<C> = {
	get: () => C;
	set: (ctx: C) => void;
	subscribe: (fn: (ctx: C) => void) => () => void;
};

export type ContentObservable = Observable<ContentCtx>;

export function contentObservable(initialCtx: ContentCtx): ContentObservable {
	type Subscriber = (ctx: ContentCtx) => void;
	const subscribers = new Set<Subscriber>();
	let ctx = initialCtx;
	function get() {
		return ctx;
	}
	function set(_ctx: ContentCtx) {
		ctx = _ctx;
		subscribers.forEach((fn) => fn(ctx));
	}
	function subscribe(fn: Subscriber) {
		subscribers.add(fn);
		return () => {
			subscribers.delete(fn);
		};
	}
	return {
		get,
		set,
		subscribe,
	};
}

export type ContentPaths = {
	contentDir: URL;
	cacheDir: URL;
	typesTemplate: URL;
	virtualModTemplate: URL;
	config: URL;
};

export function getContentPaths({
	srcDir,
	root,
}: Pick<AstroConfig, 'root' | 'srcDir'>): ContentPaths {
	const templateDir = new URL('../../src/content/template/', import.meta.url);
	return {
		cacheDir: new URL('.astro/', root),
		contentDir: new URL('./content/', srcDir),
		typesTemplate: new URL('types.d.ts', templateDir),
		virtualModTemplate: new URL('virtual-mod.mjs', templateDir),
		config: new URL('./content/config.ts', srcDir),
	};
}