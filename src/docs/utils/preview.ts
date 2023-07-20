import { highlightCode } from '$docs/highlighter';
import { isBrowser } from '$lib/internal/helpers';
import { error } from '@sveltejs/kit';
import type { SvelteComponent } from 'svelte';
import { get, writable } from 'svelte/store';
import rawGlobalCSS from '../../../other/globalcss.html?raw';
import rawTailwindConfig from '../../../other/tailwindconfig.html?raw';
import { data, isBuilderName, type Builder } from '../data/builders';
import { processMeltAttributes } from '../pp';
import type { DocResolver, PreviewFile, PreviewResolver } from '../types';

function slugFromPath(path: string) {
	return path.replace('/src/docs/content/', '').replace('.md', '');
}

function previewPathMatcher(path: string, builder: string) {
	const strippedPath = path.replace('/src/docs/previews/', '');
	const builderPath = strippedPath.split('/')[0];
	return builderPath === builder;
}

interface PreviewObj {
	[key: string]: {
		[key: string]: {
			'index.svelte'?: {
				pp: string;
				base: string;
			};
			'globals.css'?: string;
			'tailwind.config.ts'?: string;
		};
	};
}

type CreatePreviewsObjectArgs = {
	component: string;
	objArr: { path: string; content: string }[];
	fetcher?: typeof fetch;
};
async function createPreviewsObject({
	component,
	objArr,
	fetcher,
}: CreatePreviewsObjectArgs): Promise<PreviewObj> {
	const returnedObj: PreviewObj = {};

	// Create an array of promises, iterating through the objects in the array
	const promises = objArr.map(async (obj) => {
		// Extract the parts from the path
		const regex = new RegExp(`${component}/(.+?)/(.+?)\\.svelte$`);
		const match = regex.exec(obj.path);

		if (match) {
			const [, groupKey, fileKey] = match; // Destructure the matched parts
			const { content } = obj;

			// Create the structure in the returnedObj
			if (!returnedObj[groupKey]) {
				returnedObj[groupKey] = {};
			}
			if (!returnedObj[groupKey][fileKey]) {
				returnedObj[groupKey][fileKey] = {};
			}

			const [highlightedCode, processedCode] = await Promise.all([
				highlightCode({ code: content, lang: 'svelte', fetcher }),
				highlightCode({ code: processMeltAttributes(content), lang: 'svelte', fetcher }),
			]);

			returnedObj[groupKey][fileKey]['index.svelte'] = {
				pp: highlightedCode ?? content,
				base: processedCode ?? content,
			};
		}
	});

	// Wait for all the promises to resolve
	await Promise.all(promises);

	// Manually add values for 'tailwind.config.ts' and 'globals.css'
	for (const groupKey in returnedObj) {
		if (Object.prototype.hasOwnProperty.call(returnedObj, groupKey)) {
			const fileKeys = Object.keys(returnedObj[groupKey]);
			for (const fileKey of fileKeys) {
				if (!Object.prototype.hasOwnProperty.call(returnedObj[groupKey], fileKey)) {
					returnedObj[groupKey][fileKey] = {};
				}

				if (fileKey === 'tailwind') {
					returnedObj[groupKey][fileKey]['tailwind.config.ts'] = rawTailwindConfig;
				} else if (fileKey === 'css') {
					returnedObj[groupKey][fileKey]['globals.css'] = rawGlobalCSS;
				}
			}
		}
	}

	return returnedObj;
}

function isMainPreviewComponent(builder: string, path: string): boolean {
	const regexPattern = `${builder}/main/tailwind\\.svelte$`;
	const regex = new RegExp(regexPattern);
	return regex.test(path);
}

export async function getDocData(slug: string) {
	const modules = import.meta.glob('/src/docs/content/builders/**/*.md');

	let match: { path?: string; resolver?: DocResolver } = {};

	for (const [path, resolver] of Object.entries(modules)) {
		const strippedPath = slugFromPath(path).split('/')[1];
		if (strippedPath === slug) {
			match = { path, resolver: resolver as unknown as DocResolver };
			break;
		}
	}

	const doc = await match?.resolver?.();

	if (!doc || !doc.metadata) {
		throw error(404);
	}
	return doc;
}

type GetAllPreviewSnippetsArgs = {
	slug: string;
	fetcher?: typeof fetch;
};

export async function getAllPreviewSnippets({ slug, fetcher }: GetAllPreviewSnippetsArgs) {
	const previewsCode = import.meta.glob(`/src/docs/previews/**/*.svelte`, {
		as: 'raw',
		eager: true,
	});

	const previewCodeMatches: { path: string; content: string }[] = [];
	for (const [path, resolver] of Object.entries(previewsCode)) {
		const isMatch = previewPathMatcher(path, slug);
		if (isMatch) {
			const prev = { path, content: resolver };
			previewCodeMatches.push(prev);
		}
	}
	const previews = await createPreviewsObject({
		component: slug,
		objArr: previewCodeMatches,
		fetcher,
	});

	return previews;
}

const getPreviewName = (path: string, slug: string) => {
	return path.replaceAll(`/src/docs/previews/${slug}/`, '').split('/')[0];
};

export async function getAllPreviewComponents(slug: string) {
	const previewComponents = import.meta.glob('/src/docs/previews/**/tailwind.svelte');

	const previewCodeMatches: { [key: string]: SvelteComponent } = {};

	const promises = Object.entries(previewComponents).map(async ([path, resolver]) => {
		const isMatch = previewPathMatcher(path, slug);
		if (!isMatch) return;
		const previewName = getPreviewName(path, slug);

		const previewComp = (await resolver?.()) as PreviewFile;
		if (!previewComp) return;
		previewCodeMatches[previewName] = previewComp.default;
	});
	await Promise.all(promises);

	return previewCodeMatches;
}

export async function getMainPreviewComponent(slug: string) {
	if (!isBuilderName(slug)) {
		throw error(500);
	}

	const previewComponents = import.meta.glob('/src/docs/previews/**/*.svelte');
	let mainPreviewObj: { path?: string; resolver?: PreviewResolver } = {};
	for (const [path, resolver] of Object.entries(previewComponents)) {
		if (isMainPreviewComponent(slug, path)) {
			mainPreviewObj = { path, resolver: resolver as unknown as PreviewResolver };
			break;
		}
	}

	const mainPreview = await mainPreviewObj.resolver?.();
	if (!mainPreview) {
		throw error(500);
	}

	return mainPreview.default;
}

export async function getBuilderData({ slug, fetcher }: GetBuilderDataArgs) {
	const builderData = data[slug];
	const schemas = builderData['schemas'];
	if (!schemas) return builderData;

	const promises = schemas.map(async (key) => {
		if (Object.prototype.hasOwnProperty.call(key, 'props')) {
			const props = key['props'];
			if (!props) return;
			for (const prop of props) {
				if (!prop['longType']) continue;
				const longType = prop['longType'];
				const highlightedCode = await highlightCode({
					code: longType.rawCode,
					lang: 'typescript',
					classes: {
						pre: '!mt-0 !mb-0',
					},
					fetcher,
				});
				prop['longType']['highlightedCode'] = highlightedCode;
			}
		}
	});
	await Promise.all(promises);

	builderData.schemas = schemas;
	return builderData;
}

export function transformAPIString(text: string | string[], defaultCodeColor = false) {
	if (Array.isArray(text)) {
		text = text.join(' | ');
	}
	text = text.replaceAll('"', "'");
	const regex = /`(.+?)`/g;
	return text.replace(regex, `<code class="${defaultCodeColor ? '' : 'neutral'}">$1</code>`);
}

export async function getDoc(slug: string) {
	const modules = import.meta.glob('/src/docs/content/**/*.md');

	let match: { path?: string; resolver?: DocResolver } = {};

	for (const [path, resolver] of Object.entries(modules)) {
		if (slugFromPath(path) === slug) {
			match = { path, resolver: resolver as unknown as DocResolver };
			break;
		}
	}

	const doc = await match?.resolver?.();

	if (!doc || !doc.metadata) {
		throw error(404);
	}
	return doc;
}

export function createHeadingId(text: string) {
	return text
		.replaceAll(/[^a-zA-Z0-9 ]/g, '')
		.replaceAll(' ', '-')
		.toLowerCase();
}

export function createCopyCodeButton() {
	const codeString = writable('');
	const copied = writable(false);
	let copyTimeout = 0;

	function copyCode() {
		if (!isBrowser) return;
		navigator.clipboard.writeText(get(codeString));
		copied.set(true);
		clearTimeout(copyTimeout);
		copyTimeout = window.setTimeout(() => {
			copied.set(false);
		}, 2500);
	}

	function setCodeString(node: HTMLElement) {
		codeString.set(node.innerText.trim() ?? '');
	}

	return {
		copied: copied,
		copyCode: copyCode,
		setCodeString: setCodeString,
	};
}

type GetBuilderDataArgs = {
	slug: Builder;
	fetcher?: typeof fetch;
};