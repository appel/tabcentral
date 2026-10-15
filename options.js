'use strict';

/**
 * TabCentral settings page: Settings, Shortcuts and About.
 *
 * Settings are stored in localStorage, which this page shares with the
 * TabCentral page (same extension origin); the TabCentral page reads them when
 * it needs them, so changes apply without a reload (the sort applies when
 * TabCentral next opens). The stored-tabs folder is a bookmark folder whose id
 * TabCentral keeps in storage.local.
 */

const DEFAULT_SORT_KEY = 'tab-central.default-sort';
const CLOSE_CONFIRM_KEY = 'tab-central.close-window-confirm';
const UNDO_TIP_KEY = 'tab-central.undo-tip-seconds';
const STORED_FOLDER_NAME_KEY = 'tab-central.stored-folder-name';
const STORED_ROOT_KEY = 'storedRootId';
const DEFAULT_STORED_FOLDER = 'Open Tabs';

const $ = selector => document.querySelector(selector);

function el(tag, attrs = {}, ...children)
{
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs))
	{
		if (value == null || value === false)
		{
			continue;
		}
		if (key === 'class')
		{
			node.className = value;
		}
		else if (key === 'text')
		{
			node.textContent = value;
		}
		else if (key === 'icon')
		{
			node.append(iconNode(value));
		}
		else if (key.startsWith('on'))
		{
			node.addEventListener(key.slice(2), value);
		}
		else
		{
			node.setAttribute(key, value === true ? '' : value);
		}
	}
	node.append(...children.filter(child => child != null && child !== false));
	return node;
}

const svg = (body, attrs) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${attrs}>${body}</svg>`;

// Static markup only, parsed once and cloned per use. Bootstrap Icons "gear", "keyboard", "info-circle" (MIT License).
const ICONS = {
	settings: svg('<path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"/>', 'fill="currentColor"'),
	shortcuts: svg('<path d="M14 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2 4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="M13 10.25a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm0-2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-5 0A.25.25 0 0 1 8.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 8 8.75zm2 0a.25.25 0 0 1 .25-.25h1.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-1.5a.25.25 0 0 1-.25-.25zm1 2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-5-2A.25.25 0 0 1 6.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 6 8.75zm-2 0A.25.25 0 0 1 4.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 4 8.75zm-2 0A.25.25 0 0 1 2.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 2 8.75zm11-2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-2 0a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-2 0A.25.25 0 0 1 9.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 9 6.75zm-2 0A.25.25 0 0 1 7.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 7 6.75zm-2 0A.25.25 0 0 1 5.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 5 6.75zm-3 0A.25.25 0 0 1 2.25 6h1.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-1.5A.25.25 0 0 1 2 6.75zm0 4a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm2 0a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-5.5a.25.25 0 0 1-.25-.25z"/>', 'fill="currentColor"'),
	about: svg('<path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>', 'fill="currentColor"'),
	close: svg('<path d="M4.5 4.5l7 7m0-7l-7 7"/>', 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"'),
};

const iconCache = new Map();

function iconNode(name)
{
	if (!iconCache.has(name))
	{
		iconCache.set(name, new DOMParser().parseFromString(ICONS[name], 'image/svg+xml').documentElement);
	}
	return document.importNode(iconCache.get(name), true);
}

function readPref(key, fallback)
{
	try
	{
		return localStorage.getItem(key) ?? fallback;
	}
	catch (err)
	{
		return fallback;
	}
}

function writePref(key, value)
{
	try
	{
		localStorage.setItem(key, value);
	}
	catch (err)
	{
		showError(new Error('This setting could not be saved: storage is not available.'));
	}
}

/* Navigation */

function showSection()
{
	const hash = location.hash.slice(1);
	const section = ['shortcuts', 'about'].includes(hash) ? hash : 'settings';
	for (const node of document.querySelectorAll('.section'))
	{
		node.hidden = node.id !== section;
	}
	for (const link of document.querySelectorAll('.nav-item'))
	{
		if (link.dataset.section === section)
		{
			link.setAttribute('aria-current', 'page');
		}
		else
		{
			link.removeAttribute('aria-current');
		}
	}
	if (section === 'shortcuts')
	{
		renderShortcuts().catch(showError);
	}
}

/* Settings */

function bindSelect(id, key, fallback, message)
{
	const select = $(`#${id}`);
	select.value = readPref(key, fallback);
	if (!select.value)
	{
		select.value = fallback;
	}
	select.addEventListener('change', () =>
	{
		writePref(key, select.value);
		showToast(message);
	});
}

async function storedRoot()
{
	const { [STORED_ROOT_KEY]: id } = await browser.storage.local.get(STORED_ROOT_KEY);
	if (!id)
	{
		return null;
	}
	const [node] = await browser.bookmarks.getSubTree(id).catch(() => []);
	return node && node.type === 'folder' ? node : null;
}

async function showStoredFolder()
{
	const root = await storedRoot();
	const input = $('#stored-folder');
	input.value = root ? root.title : readPref(STORED_FOLDER_NAME_KEY, DEFAULT_STORED_FOLDER);
	const sets = root ? (root.children || []).filter(child => child.type === 'folder').length : 0;
	$('#stored-folder-hint').textContent = root
		? `${sets === 1 ? '1 stored set' : `${sets} stored sets`} in this folder`
		: 'Created the first time you store tabs';
}

// Renames the existing folder (if there is one) and remembers the name for when it has to be created.
async function renameStoredFolder()
{
	const input = $('#stored-folder');
	const name = input.value.trim().slice(0, 100);
	if (!name)
	{
		await showStoredFolder();
		return;
	}
	writePref(STORED_FOLDER_NAME_KEY, name);
	const root = await storedRoot();
	if (root && root.title !== name)
	{
		await browser.bookmarks.update(root.id, { title: name });
	}
	showToast(`Stored tabs folder: ${name}`);
	await showStoredFolder();
}

/* Toast */

let toastTimer = null;

function showToast(message, isError = false)
{
	const toast = $('#toast');
	toast.textContent = message;
	toast.classList.toggle('error', isError);
	toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { toast.hidden = true; }, isError ? 6000 : 2500);
}

function showError(err)
{
	console.error(err);
	showToast(err?.message || String(err), true);
}

/* Start */

async function init()
{
	for (const link of document.querySelectorAll('.nav-item[data-icon]'))
	{
		link.prepend(iconNode(link.dataset.icon));
	}
	$('#version').textContent = `version ${browser.runtime.getManifest().version}`;

	bindSelect('default-sort', DEFAULT_SORT_KEY, 'last', 'Saved. Applies when TabCentral next opens.');
	bindSelect('close-window-confirm', CLOSE_CONFIRM_KEY, '50', 'Saved');
	bindSelect('undo-tip', UNDO_TIP_KEY, '5', 'Saved');

	const folderInput = $('#stored-folder');
	folderInput.addEventListener('change', () => renameStoredFolder().catch(showError));
	folderInput.addEventListener('keydown', e =>
	{
		if (e.key === 'Enter')
		{
			folderInput.blur();
		}
	});
	await showStoredFolder();

	bindShortcuts();
	window.addEventListener('hashchange', showSection);
	showSection();
}

init().catch(showError);
