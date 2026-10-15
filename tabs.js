'use strict';

/**
 * TabCentral page: lists the tabs of all windows with search, sorting,
 * multi-select, drag and drop between windows and tab group management.
 *
 * The page keeps a snapshot of all tabs in `state`, refreshed (debounced) on
 * every tab, window and group event, and rebuilds the window cards from it.
 *
 * "Stored tabs" are bookmark folders under Other Bookmarks > Open Tabs, one
 * folder per save, with a subfolder per tab group.
 */

const MAX_ROWS = 7;
const NO_GROUP = -1;
const GROUP_COLORS = ['grey', 'blue', 'purple', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink'];
const OWN_PREFIX = browser.runtime.getURL('');
const HAS_GROUPS = !!(browser.tabGroups && browser.tabs.group && browser.tabs.ungroup);
const HAS_BOOKMARKS = !!browser.bookmarks;
const HAS_SESSIONS = !!(browser.sessions && browser.sessions.setWindowValue);
const WINDOW_NAME_KEY = 'name';
const TITLE_PREFACE_SEPARATOR = ' — ';
const DATE_TITLE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const DEFAULT_FAVICON = 'icons/globe.svg';
const EXTENSION_FAVICON = 'icons/extension.svg';
const SORT_KEY = 'tab-central.sort';
// Set on the settings page (options.html), read when needed.
const DEFAULT_SORT_KEY = 'tab-central.default-sort';
const CLOSE_CONFIRM_KEY = 'tab-central.close-window-confirm';
const UNDO_TIP_KEY = 'tab-central.undo-tip-seconds';
const STORED_FOLDER_NAME_KEY = 'tab-central.stored-folder-name';
const OPTIONS_URL = browser.runtime.getURL('options.html');
const CARD_SIZE_KEY = 'tab-central.card-size';
const EXPAND_KEY = 'tab-central.expand-all';
const STORED_OPEN_KEY = 'tab-central.stored-open';
const VIEW_STATE_KEY = 'tab-central.view-state';
const WINDOW_VIEW_KEY = 'view';
const FAVICON_KEY = 'tab-central.favicons';
const CARD_SIZES = ['small', 'normal', 'big', 'single'];
const CARD_SIZE_LABELS = { small: '4 columns', normal: '3 columns', big: '2 columns', single: '1 column' };
const CARD_SIZE_ICONS = { small: 'columns4', normal: 'columns3', big: 'columns2', single: 'columns1' };
const STORED_PARENT = 'unfiled_____';
const STORED_FOLDER = 'Open Tabs';  // default name; can be changed on the settings page
const STORED_ROOT_KEY = 'storedRootId';
const MAX_FAVICONS = 300;
const MAX_FAVICON_LENGTH = 4096;

// New-tab style pages: closed on save, but not worth storing.
const EMPTY_URLS = ['about:blank', 'about:newtab', 'about:home', 'about:privatebrowsing'];

const svg = (body, attrs = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"') =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${attrs}>${body}</svg>`;

// Static markup, parsed once and cloned per use. Tab titles and URLs are always set via textContent.
const ICONS = {
	chevron: svg('<path d="M4 10l4-4 4 4"/>'),
	arrow: svg('<path d="M6 4l4 4-4 4"/>'),
	close: svg('<path d="M4.5 4.5l7 7m0-7l-7 7"/>'),
	more: svg('<circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/>', 'fill="currentColor"'),
	audio: svg('<path d="M2 6h2.5L8 3v10l-3.5-3H2z" fill="currentColor"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9"/>'),
	muted: svg('<path d="M2 6h2.5L8 3v10l-3.5-3H2z" fill="currentColor"/><path d="M10.5 6l4 4m0-4l-4 4"/>'),
	expandAll: svg('<path d="M4.5 5L8 1.5 11.5 5M4.5 11L8 14.5 11.5 11M3 8h10"/>'),
	columns4: svg('<rect x="1" y="2" width="2.5" height="12" rx="0.75"/><rect x="4.83" y="2" width="2.5" height="12" rx="0.75"/><rect x="8.67" y="2" width="2.5" height="12" rx="0.75"/><rect x="12.5" y="2" width="2.5" height="12" rx="0.75"/>', 'fill="currentColor"'),
	columns3: svg('<rect x="1" y="2" width="3.67" height="12" rx="0.75"/><rect x="6.17" y="2" width="3.67" height="12" rx="0.75"/><rect x="11.33" y="2" width="3.67" height="12" rx="0.75"/>', 'fill="currentColor"'),
	columns2: svg('<rect x="1" y="2" width="6.25" height="12" rx="0.75"/><rect x="8.75" y="2" width="6.25" height="12" rx="0.75"/>', 'fill="currentColor"'),
	columns1: svg('<rect x="1" y="2" width="14" height="12" rx="0.75"/>', 'fill="currentColor"'),
	collapseAll: svg('<path d="M4.5 2L8 5.5 11.5 2M4.5 14L8 10.5 11.5 14M3 8h10"/>'),
};

const state = {
	windows: [],            // [{id, number, name, current, tabs (sorted by index, own page excluded)}]
	tabsById: new Map(),
	groupsById: new Map(),
	sort: 'order',
	cardSize: 'normal',
	query: '',
	stored: [],             // [{id, title, dateAdded, count, items: [{type: 'tab', ...} | {type: 'group', title, tabs}]}]
	selection: new Set(),
	selectionAnchor: null,
	selectedWindows: new Set(),
	collapsedWindows: new Set(),  // window ids and stored folder ids
	expandedWindows: new Set(),   // cards whose "Show more" state differs from expandAll
	expandAll: false,
	storedOpen: false,      // the Stored tabs section; collapsed by default
	storedClosedInSearch: false, // the section was collapsed during the current search
	collapsedGroups: new Set(),
	favicons: {},           // host => favicon URL, remembered for stored tabs
	drag: null,
	dropEl: null,
	dropClass: null,
	busy: 0,
	editing: false,         // a window title is being renamed inline
	prefaced: new Set(),    // windows whose title preface was applied by this page
	renderPending: false,
	renderedSignature: '',
	hiddenCount: 0,         // tabs hidden by other extensions, not listed
	placeholders: new Map(), // ghosts of closed rows/cards while their undo runs, by key
	closing: new Set(),     // layout keys (t<id>, w<id>) of tabs and windows being closed: not rendered
	renderedQuery: '',      // the search the page currently shows
	keyAliases: new Map(),  // layout key of a restored tab/window -> key of its ghost, for one render
	windowOrder: [],        // window ids in display order, including recently closed ones
	viewLoaded: new Set(),  // windows whose saved collapsed / "Show more" state was read
	rovingKey: null,        // the one row that is a Tab stop (layout key)
	stale: false,
};

const $ = selector => document.querySelector(selector);

const iconCache = new Map();

function iconNode(name)
{
	if (!iconCache.has(name))
	{
		const doc = new DOMParser().parseFromString(ICONS[name], 'image/svg+xml');
		iconCache.set(name, doc.documentElement);
	}
	return document.importNode(iconCache.get(name), true);
}

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
		else if (key === 'dataset')
		{
			Object.assign(node.dataset, value);
		}
		else if (key === 'style')
		{
			for (const [prop, val] of Object.entries(value))
			{
				node.style.setProperty(prop, val);
			}
		}
		else
		{
			node.setAttribute(key, value === true ? '' : value);
		}
	}
	node.append(...children.filter(child => child != null));
	return node;
}

function groupIdOf(tab)
{
	return HAS_GROUPS && typeof tab.groupId === 'number' ? tab.groupId : NO_GROUP;
}

function groupColor(color)
{
	return `var(--group-${GROUP_COLORS.includes(color) ? color : 'grey'})`;
}

function windowName(win)
{
	return `${win.name || `Window ${win.number}`}${win.current ? ' (Current)' : ''}`;
}

function getWindow(windowId)
{
	return state.windows.find(win => win.id === windowId);
}

function tabsOf(ids)
{
	return ids.map(id => state.tabsById.get(id)).filter(Boolean);
}

function tabsInGroup(groupId)
{
	return [...state.tabsById.values()].filter(tab => groupIdOf(tab) === groupId).sort((a, b) => a.index - b.index);
}

// Sort tab ids by window display order, then by tab index.
function orderIds(ids)
{
	const position = new Map(state.windows.map((win, i) => [win.id, i]));
	return tabsOf([...ids])
		.sort((a, b) => (position.get(a.windowId) - position.get(b.windowId)) || (a.index - b.index))
		.map(tab => tab.id);
}

// A menu or drag on a selected tab acts on the whole selection, otherwise on that tab only.
function actionIds(tabId)
{
	return state.selection.has(tabId) && state.selection.size > 1 ? orderIds(state.selection) : [tabId];
}

function plural(count, one, many)
{
	return count === 1 ? one : many.replace('#', count);
}

/* Data loading */

let loadSeq = 0;
let refreshTimer = null;

async function load()
{
	const seq = ++loadSeq;
	const [tabs, windows, current, groups, stored] = await Promise.all([
		browser.tabs.query({ windowType: 'normal' }),
		browser.windows.getAll({ windowTypes: ['normal'] }),
		browser.windows.getCurrent(),
		HAS_GROUPS ? browser.tabGroups.query({}) : [],
		loadStored(),
	]);
	const names = HAS_SESSIONS
		? await Promise.all(windows.map(win => browser.sessions.getWindowValue(win.id, WINDOW_NAME_KEY).catch(() => null)))
		: [];
	// Saved collapsed / "Show more" state, read once per window; after that the page's own state is leading.
	const unread = windows.filter(win => !state.viewLoaded.has(win.id));
	const views = HAS_SESSIONS && unread.length
		? await Promise.all(unread.map(win => browser.sessions.getWindowValue(win.id, WINDOW_VIEW_KEY).catch(() => null)))
		: [];

	// A newer load started while this one was waiting; its data wins.
	if (seq !== loadSeq)
	{
		return false;
	}
	unread.forEach((win, i) => applySavedWindowView(win.id, views[i]));
	const nameById = new Map(windows.map((win, i) => [win.id, typeof names[i] === 'string' ? names[i] : '']));

	const byWindow = new Map(windows.map(win => [win.id, []]));
	state.tabsById = new Map();
	state.hiddenCount = 0;
	for (const tab of tabs)
	{
		if (tab.url && tab.url.startsWith(OWN_PREFIX))
		{
			continue;
		}
		// Tabs hidden by other extensions (tabs.hide) are not in the tab strip either.
		if (tab.hidden)
		{
			state.hiddenCount++;
			continue;
		}
		state.tabsById.set(tab.id, tab);
		byWindow.get(tab.windowId)?.push(tab);
	}

	state.stored = stored;
	state.groupsById = new Map(groups.map(group => [group.id, group]));
	// Current window first, then the order windows were first seen in. Undo maps a restored
	// window's new id onto the old one, so it comes back in its old place.
	const known = new Set();
	state.windowOrder = state.windowOrder.map(resolveWindow).filter(id => !known.has(id) && known.add(id)).slice(-500);
	for (const win of windows)
	{
		if (!known.has(win.id))
		{
			state.windowOrder.push(win.id);
			known.add(win.id);
		}
	}
	const position = new Map(state.windowOrder.map((id, i) => [id, i]));
	const ordered = [...windows].sort((a, b) => ((b.id === current.id) - (a.id === current.id)) || (position.get(a.id) - position.get(b.id)));
	state.windows = ordered.map((win, i) => ({
		id: win.id,
		number: i + 1,
		name: nameById.get(win.id),
		current: win.id === current.id,
		tabs: (byWindow.get(win.id) || []).sort((a, b) => a.index - b.index),
	}));

	// The title preface is not part of session restore; reapply it once per window.
	for (const win of state.windows)
	{
		if (win.name && !state.prefaced.has(win.id))
		{
			state.prefaced.add(win.id);
			browser.windows.update(win.id, { titlePreface: win.name + TITLE_PREFACE_SEPARATOR }).catch(console.error);
		}
	}

	for (const id of state.selection)
	{
		if (!state.tabsById.has(id))
		{
			state.selection.delete(id);
		}
	}
	for (const id of state.selectedWindows)
	{
		if (!getWindow(id))
		{
			state.selectedWindows.delete(id);
		}
	}
	for (const key of state.closing)
	{
		const id = Number(key.slice(1));
		if (key[0] === 't' ? !state.tabsById.has(id) : !getWindow(id))
		{
			state.closing.delete(key);
		}
	}
	return true;
}

/**
 * The stored tabs folder. Its id is remembered in extension storage, so a
 * bookmark folder of your own named "Open Tabs" is never mistaken for it,
 * and the folder keeps working when renamed or moved. Without a remembered id
 * (first run, reinstall), an "Open Tabs" folder is only adopted when it looks
 * like ours: it contains nothing but folders.
 */
let storedRootId = null;

async function findStoredRoot(create)
{
	if (!storedRootId)
	{
		storedRootId = (await browser.storage.local.get(STORED_ROOT_KEY))[STORED_ROOT_KEY] || null;
	}
	if (storedRootId)
	{
		const [node] = await browser.bookmarks.get(storedRootId).catch(() => []);
		if (node && node.type === 'folder')
		{
			return storedRootId;
		}
		storedRootId = null;
	}

	for (const node of await browser.bookmarks.getChildren(STORED_PARENT))
	{
		if (node.type === 'folder' && node.title === storedFolderName())
		{
			const inside = await browser.bookmarks.getChildren(node.id);
			if (inside.every(child => child.type === 'folder'))
			{
				return rememberStoredRoot(node.id);
			}
		}
	}
	if (!create)
	{
		return null;
	}
	return rememberStoredRoot((await browser.bookmarks.create({ parentId: STORED_PARENT, title: storedFolderName() })).id);
}

function storedFolderName()
{
	return readPref(STORED_FOLDER_NAME_KEY, '').trim() || STORED_FOLDER;
}

async function rememberStoredRoot(id)
{
	storedRootId = id;
	await browser.storage.local.set({ [STORED_ROOT_KEY]: id });
	return id;
}

async function loadStored()
{
	if (!HAS_BOOKMARKS)
	{
		return [];
	}
	const rootId = await findStoredRoot(false);
	if (!rootId)
	{
		return [];
	}

	const toTab = node => ({ type: 'tab', id: node.id, title: node.title || node.url, url: node.url });
	const [root] = await browser.bookmarks.getSubTree(rootId);
	return (root.children || [])
		.filter(folder => folder.type === 'folder')
		.map(folder =>
		{
			const items = (folder.children || []).map(node =>
			{
				if (node.type === 'bookmark')
				{
					return toTab(node);
				}
				if (node.type === 'folder')
				{
					return { type: 'group', id: node.id, title: node.title, tabs: (node.children || []).filter(child => child.type === 'bookmark').map(toTab) };
				}
				return null;
			}).filter(Boolean);
			const count = items.reduce((sum, item) => sum + (item.type === 'group' ? item.tabs.length : 1), 0);
			return { id: folder.id, title: folder.title, dateAdded: folder.dateAdded || 0, count, items };
		})
		.sort((a, b) => b.dateAdded - a.dateAdded);
}

// Tab events come in bursts; one refresh per burst is enough.
function scheduleRefresh()
{
	if (!refreshTimer)
	{
		refreshTimer = setTimeout(refresh, 100);
	}
}

async function refresh()
{
	clearTimeout(refreshTimer);
	refreshTimer = null;
	if (document.hidden)
	{
		state.stale = true;
		return;
	}
	try
	{
		if (await load() && (state.renderPending || dataSignature() !== state.renderedSignature))
		{
			render();
		}
	}
	catch (err)
	{
		showError(err);
	}
}

/**
 * Runs a user action. Actions run one at a time, in order: two quick clicks
 * cannot interleave their moves, and undo snapshots stay consistent.
 * Rendering is deferred until the queue is empty so a multi-step move does
 * not flicker, and a busy overlay appears if it takes a while.
 * With a label, the action is recorded for undo, also when it failed halfway.
 */
let actionQueue = Promise.resolve();

/**
 * Options: quiet - no busy overlay; fresh - reload pending tab events before
 * the action (on by default; undo works from its own snapshots and skips it).
 */
function run(action, label = null, { quiet = false, fresh = true } = {})
{
	state.busy++;
	if (!quiet)
	{
		scheduleBusyOverlay();
	}
	const task = actionQueue.then(() => execute(action, label, fresh));
	actionQueue = task;
	return task;
}

// Never rejects, so the queue keeps going after a failed action. Resolves to the undo entry, if one was recorded.
async function execute(action, label, fresh)
{
	let before = null;
	let result = null;
	let entry = null;
	try
	{
		// A tab event arrived since the last load: make sure the action sees current data.
		if (fresh && (refreshTimer || state.stale))
		{
			clearTimeout(refreshTimer);
			refreshTimer = null;
			state.stale = false;
			state.renderPending = true;
			await load();
		}
		before = label ? await captureLayout() : null;
		result = await action();
	}
	catch (err)
	{
		showError(err);
	}
	finally
	{
		if (before)
		{
			entry = await recordHistory(label, before, result).catch(console.error) || null;
			if (entry)
			{
				announce(`${label}. Press Ctrl+Z to undo.`);
			}
		}
		state.busy--;
		if (!state.busy)
		{
			// Show the result of the user's action right away rather than after the event debounce.
			hideBusyOverlay();
			refresh();
		}
	}
	return entry;
}

// Quick actions finish before the overlay shows, so it never flickers.
const BUSY_OVERLAY_DELAY = 400;
let busyTimer = null;

function scheduleBusyOverlay()
{
	if (!busyTimer && $('#busy').hidden)
	{
		busyTimer = setTimeout(() =>
		{
			busyTimer = null;
			if (state.busy)
			{
				$('#busy').hidden = false;
			}
		}, BUSY_OVERLAY_DELAY);
	}
}

function hideBusyOverlay()
{
	clearTimeout(busyTimer);
	busyTimer = null;
	$('#busy').hidden = true;
	setBusyText('');
}

// Progress text under the spinner, for long actions such as restoring a backup.
function setBusyText(text)
{
	$('#busy-text').textContent = text;
}

/* Rendering */

/**
 * Rebuilds the window and stored cards from `state`. Unless `animate` is
 * false, elements slide from their old position to the new one.
 */
function render({ animate = true } = {})
{
	if (state.drag || state.busy || state.editing)
	{
		state.renderPending = true;
		return;
	}
	state.renderPending = false;
	state.renderedSignature = dataSignature();
	state.renderedQuery = state.query;

	const previous = animate && canAnimate() ? measureLayout() : null;
	const focusedId = document.activeElement?.closest?.('[data-tab-id]')?.dataset.tabId;
	const filter = searchFilter(state.query);

	const cards = placeholdersAfter('window', null, null);
	let windowCount = 0;
	for (const win of state.windows)
	{
		const card = !state.closing.has(`w${win.id}`) && renderWindow(win, filter);
		if (card)
		{
			windowCount++;
			cards.push(card, ...placeholdersAfter('window', null, `w${win.id}`));
		}
	}
	// A collapsed Stored tabs section is not rendered.
	const storedVisible = isStoredOpen(!!filter);
	const storedCards = storedVisible ? state.stored.map(set => renderStored(set, filter)).filter(Boolean) : [];
	$('#no-results').hidden = !(filter && !windowCount && !storedCards.length);
	cards.push(el('div', { id: 'new-window-zone', class: 'drop-zone', text: 'Drop here to move to a new window' }));
	$('#windows').replaceChildren(...cards);
	$('#stored').replaceChildren(...storedCards);
	$('#stored-section').hidden = filter ? !(storedVisible ? storedCards.length : state.stored.some(set => renderStored(set, filter))) : !state.stored.length;
	applyStoredOpen(storedVisible);
	const storedTabCount = state.stored.reduce((sum, set) => sum + set.count, 0);
	$('#stored-count').textContent = `(${plural(state.stored.length, '1 set', '# sets')}, ${plural(storedTabCount, '1 tab', '# tabs')})`;
	updateTabCount();
	pruneSelection();
	updateSelectionUi();
	updateViewControls();

	if (focusedId)
	{
		document.querySelector(`#windows [data-tab-id="${focusedId}"]`)?.focus({ preventScroll: true });
	}
	if (previous)
	{
		animateLayout(previous);
	}
	state.keyAliases.clear();
	updateRovingStop();
	saveViewState();
}

function updateTabCount()
{
	const total = state.tabsById.size;
	const unloaded = [...state.tabsById.values()].filter(tab => tab.discarded).length;
	const count = $('#tab-count');
	count.textContent = `(${total})` + (state.hiddenCount ? ` · ${state.hiddenCount} hidden` : '');
	count.title = `${plural(total, '1 tab', '# tabs')} in ${plural(state.windows.length, '1 window', '# windows')}, ${unloaded} not loaded`
		+ (state.hiddenCount ? `
${plural(state.hiddenCount, '1 tab is', '# tabs are')} hidden by another extension and not listed` : '');
}

function isStoredOpen(searching)
{
	return searching ? !state.storedClosedInSearch : state.storedOpen;
}

function applyStoredOpen(open)
{
	$('#stored').hidden = !open;
	$('#stored-section').classList.toggle('collapsed', !open);
	$('#stored-toggle').setAttribute('aria-expanded', String(open));
	$('#stored-toggle').title = open ? 'Collapse' : 'Expand';
}

/* Saved view state */

/**
 * Collapsed windows and their "Show more" state are saved as session data on
 * the window (like its name), so they survive reloads and Firefox restarts.
 * Collapsed groups and stored sets are saved by id in local storage. Group ids
 * may not survive a Firefox restart, in which case groups start expanded.
 */
const savedWindowViews = new Map();
let savedLocalView = '';

function applySavedWindowView(windowId, view)
{
	state.viewLoaded.add(windowId);
	if (view && typeof view === 'object')
	{
		if (view.collapsed === true)
		{
			state.collapsedWindows.add(windowId);
		}
		if (view.toggled === true)
		{
			state.expandedWindows.add(windowId);
		}
	}
	savedWindowViews.set(windowId, JSON.stringify({ collapsed: state.collapsedWindows.has(windowId), toggled: state.expandedWindows.has(windowId) }));
}

// Writes what changed since the last save; called after every render.
function saveViewState()
{
	if (HAS_SESSIONS)
	{
		for (const win of state.windows)
		{
			if (!state.viewLoaded.has(win.id))
			{
				continue;
			}
			const view = { collapsed: state.collapsedWindows.has(win.id), toggled: state.expandedWindows.has(win.id) };
			const json = JSON.stringify(view);
			if (savedWindowViews.get(win.id) !== json)
			{
				savedWindowViews.set(win.id, json);
				browser.sessions.setWindowValue(win.id, WINDOW_VIEW_KEY, view).catch(console.error);
			}
		}
	}
	const local = JSON.stringify({
		groups: [...state.collapsedGroups].filter(id => state.groupsById.has(id)),
		stored: [...state.collapsedWindows].filter(id => typeof id === 'string' && state.stored.some(set => set.id === id)),
		storedToggled: [...state.expandedWindows].filter(id => typeof id === 'string' && state.stored.some(set => set.id === id)),
	});
	if (local !== savedLocalView)
	{
		savedLocalView = local;
		writePref(VIEW_STATE_KEY, local);
	}
}

function loadLocalViewState()
{
	try
	{
		const view = JSON.parse(readPref(VIEW_STATE_KEY, '{}')) || {};
		const list = (value, type) => Array.isArray(value) ? value.filter(item => typeof item === type) : [];
		list(view.groups, 'number').forEach(id => state.collapsedGroups.add(id));
		list(view.stored, 'string').forEach(id => state.collapsedWindows.add(id));
		list(view.storedToggled, 'string').forEach(id => state.expandedWindows.add(id));
	}
	catch (err)
	{
		// Unreadable saved state: start with everything expanded.
	}
}

// Only what is visible can be selected, so actions never hit hidden tabs.
function pruneSelection()
{
	const visible = new Set(visibleTabIds());
	for (const id of state.selection)
	{
		if (!visible.has(id))
		{
			state.selection.delete(id);
		}
	}
	const cards = new Set([...document.querySelectorAll('#windows .card[data-window-id]')].map(card => Number(card.dataset.windowId)));
	for (const id of state.selectedWindows)
	{
		if (!cards.has(id))
		{
			state.selectedWindows.delete(id);
		}
	}
}

/**
 * Cheap fingerprint of everything the page shows. A refresh whose data has
 * the same fingerprint as the last render skips rendering; tab events such as
 * loading progress fire far more often than anything visible changes.
 */
function dataSignature()
{
	const recent = state.sort === 'recent';
	const icon = url => url ? `${url.length}:${url.slice(-24)}` : '';
	return JSON.stringify([
		state.windows.map(win => [win.id, win.name, win.current, win.tabs.map(tab => [
			tab.id, tab.index, tab.title, tab.url, icon(tab.favIconUrl), tab.pinned, tab.audible, !!tab.mutedInfo?.muted, tab.discarded, groupIdOf(tab),
			recent ? tab.lastAccessed : 0,
		])]),
		[...state.groupsById.values()].map(group => [group.id, group.title, group.color, group.collapsed]),
		state.stored,
		state.hiddenCount,
	]);
}

/* Animations */

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const MOVE_ANIMATION = { id: 'layout-move', duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
const FADE_ANIMATION = { id: 'layout-fade', duration: 150, easing: 'ease-out' };
const COLLAPSE_ANIMATION = { id: 'layout-collapse', duration: 160, easing: 'ease-in', fill: 'forwards' };
const LAYOUT_ANIMATION_IDS = new Set([MOVE_ANIMATION.id, FADE_ANIMATION.id, COLLAPSE_ANIMATION.id]);
const ANIMATED = '.card, [data-tab-id], [data-bookmark-id], .group-header[data-group-id]';

// Measuring thousands of rows twice per render costs more than the animation is worth.
const MAX_ANIMATED = 600;

function canAnimate()
{
	return !reducedMotion.matches && !document.hidden;
}

function layoutKey(node)
{
	if (node.classList.contains('card'))
	{
		return node.dataset.windowId ? `w${node.dataset.windowId}` : `s${node.dataset.storedId}`;
	}
	if (node.dataset.tabId)
	{
		return `t${node.dataset.tabId}`;
	}
	return node.dataset.bookmarkId ? `b${node.dataset.bookmarkId}` : `g${node.dataset.groupId}`;
}

function animatedNodes()
{
	return document.querySelectorAll(`#windows :is(${ANIMATED}):not(.ghost, .ghost *), #stored :is(${ANIMATED})`);
}

function measureLayout()
{
	const nodes = animatedNodes();
	if (nodes.length > MAX_ANIMATED)
	{
		return null;
	}
	const rects = new Map();
	for (const node of nodes)
	{
		rects.set(layoutKey(node), node.getBoundingClientRect());
	}
	for (const node of document.querySelectorAll('#windows [data-ghost]'))
	{
		rects.set(node.dataset.ghost, node.getBoundingClientRect());
	}
	return rects;
}

/**
 * Slides elements from their previous position to the new one (FLIP), fades
 * in new elements and reveals the added height of a growing card. Row offsets
 * are corrected for the movement of their card, which animates as well.
 * Removed elements simply disappear; their neighbours slide into place.
 */
function animateLayout(previous)
{
	const all = animatedNodes();
	if (all.length > MAX_ANIMATED)
	{
		return;
	}
	// Measure everything before starting any animation: a moving card shifts its rows' rects.
	const nodes = [...all].map(node => ({ node, key: layoutKey(node), rect: node.getBoundingClientRect(), isCard: node.classList.contains('card') }));
	const cardShift = new Map();
	const height = innerHeight;
	const onScreen = (...rects) => rects.some(rect => rect.bottom > 0 && rect.top < height);

	for (const { node, key, rect, isCard } of nodes.sort((a, b) => b.isCard - a.isCard))
	{
		const old = previous.get(key) || previous.get(state.keyAliases.get(key));
		const card = isCard ? null : node.closest('.card');
		if (!old)
		{
			// New rows inside a new card are covered by the card's own fade.
			if (onScreen(rect) && (isCard || cardShift.has(card)))
			{
				node.animate({ opacity: [0, 1] }, FADE_ANIMATION);
			}
			continue;
		}

		const parent = (card && cardShift.get(card)) || { dx: 0, dy: 0 };
		const dx = old.left - rect.left - parent.dx;
		const dy = old.top - rect.top - parent.dy;
		if (isCard)
		{
			cardShift.set(node, { dx, dy });
		}
		if (!onScreen(old, rect))
		{
			continue;
		}
		if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
		{
			node.animate({ transform: [`translate(${dx}px, ${dy}px)`, 'none'] }, MOVE_ANIMATION);
		}
		if (isCard && rect.height > old.height + 1)
		{
			node.animate({ clipPath: [`inset(0 0 ${rect.height - old.height}px 0 round 8px)`, 'inset(0 0 0 0 round 8px)'] }, MOVE_ANIMATION);
		}
	}
}

function renderWindow(win, filter)
{
	const orderMode = state.sort === 'order';
	let pinned = liveTabs(win).filter(tab => tab.pinned);
	let rows = windowRows(win);

	// While searching, pinned tabs are listed as rows like any other tab.
	if (filter)
	{
		rows = sortRows(liveTabs(win).filter(filter));
		pinned = [];
		if (!rows.length)
		{
			return null;
		}
	}

	// A search shows its matches even in collapsed windows and groups.
	const collapsed = !filter && state.collapsedWindows.has(win.id);
	const meta = collapsed ? plural(win.tabs.length, '1 tab', '# tabs') : null;
	const card = renderCardShell({ title: windowName(win), meta, collapsed, menuTitle: 'Window options' });
	card.dataset.windowId = win.id;
	card.setAttribute('aria-label', windowName(win));
	card.classList.toggle('selected-window', state.selectedWindows.has(win.id));
	if (collapsed)
	{
		return card;
	}

	const body = el('div', { class: 'card-body' });
	if (pinned.length)
	{
		body.append(el('div', { class: 'pinned-strip', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': `Pinned tabs in ${windowName(win)}` }, ...pinned.map(renderPinned)));
	}

	const isHiddenInGroup = tab => !filter && orderMode && groupIdOf(tab) !== NO_GROUP && state.collapsedGroups.has(groupIdOf(tab));
	const candidates = rows.filter(tab => !isHiddenInGroup(tab)).length;
	const limit = filter || isExpanded(win.id) ? Infinity : MAX_ROWS;
	const list = el('ul', { class: 'tab-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': `Tabs in ${windowName(win)}` }, ...placeholdersAfter('tab', win.id, null));
	let shown = 0;
	let lastGroup = NO_GROUP;

	for (const tab of rows)
	{
		if (shown >= limit)
		{
			break;
		}
		const groupId = groupIdOf(tab);
		if (orderMode && groupId !== NO_GROUP && groupId !== lastGroup)
		{
			list.append(renderGroupHeader(groupId, win), ...placeholdersAfter('tab', win.id, `g${groupId}`));
		}
		lastGroup = groupId;
		if (isHiddenInGroup(tab))
		{
			continue;
		}
		list.append(renderTab(tab, orderMode), ...placeholdersAfter('tab', win.id, `t${tab.id}`));
		shown++;
	}

	if (list.children.length)
	{
		body.append(list);
	}
	else if (!pinned.length)
	{
		body.append(el('p', { class: 'empty-window', text: 'No other tabs' }));
	}

	if (!filter && candidates > MAX_ROWS)
	{
		body.append(renderShowMore(win.id, candidates - shown));
	}

	card.append(body);
	return card;
}

// Unpinned tabs of a window in display order; pinned tabs are shown in the strip above.
function windowRows(win)
{
	return sortRows(liveTabs(win).filter(tab => !tab.pinned));
}

// A window's tabs without the ones being closed.
function liveTabs(win)
{
	return state.closing.size ? win.tabs.filter(tab => !state.closing.has(`t${tab.id}`)) : win.tabs;
}

function sortRows(tabs)
{
	return state.sort === 'order' ? tabs : [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

/* Closing with undo */

// Settings (options.html): seconds the Undo tip stays, and above how many tabs closing a window asks first.
function undoTipMs()
{
	const seconds = Number(readPref(UNDO_TIP_KEY, '5'));
	return (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
}

function closeWindowConfirmLimit()
{
	const value = readPref(CLOSE_CONFIRM_KEY, '50');
	if (value === 'never')
	{
		return Infinity;
	}
	const limit = Number(value);
	return Number.isFinite(limit) && limit >= 0 ? limit : 50;
}
let undoTip = null;

/**
 * Ghosts of closed rows and cards while their undo runs, placed after the
 * element with `key` (null: the start of the list), including ghosts that
 * follow other ghosts. scopeId is the window id for tabs, null for windows.
 */
function placeholdersAfter(kind, scopeId, key)
{
	const nodes = [];
	for (const placeholder of state.placeholders.values())
	{
		if (placeholder.kind === kind && placeholder.scopeId === scopeId && placeholder.after === key)
		{
			nodes.push(ghostOf(placeholder), ...placeholdersAfter(kind, scopeId, placeholder.key));
		}
	}
	return nodes;
}

/**
 * Inert copy of the closed row or card. Its rows keep their old layout keys
 * (data-ghost), so when the restored tab (with a new id) replaces it, the
 * animation sees the same element in the same place and nothing flickers.
 */
function ghostOf(placeholder)
{
	const ghost = placeholder.original.cloneNode(true);
	for (const node of [ghost, ...ghost.querySelectorAll('[data-tab-id], [data-window-id], [data-group-id]')])
	{
		if (node.dataset.tabId || node.dataset.windowId)
		{
			node.dataset.ghost = node.dataset.tabId ? `t${node.dataset.tabId}` : `w${node.dataset.windowId}`;
		}
		delete node.dataset.tabId;
		delete node.dataset.windowId;
		delete node.dataset.groupId;
		node.classList.remove('selected', 'selected-window', 'flash');
	}
	ghost.dataset.placeholder = placeholder.key;
	ghost.classList.add('ghost');
	ghost.setAttribute('aria-hidden', 'true');
	for (const node of ghost.querySelectorAll('[tabindex]'))
	{
		node.tabIndex = -1;
	}
	return ghost;
}

// Layout key of the closest earlier sibling that stays: the spot a ghost returns to.
function previousKey(node)
{
	let prev = node.previousElementSibling;
	while (prev && !prev.dataset.placeholder && state.closing.has(layoutKey(prev)))
	{
		prev = prev.previousElementSibling;
	}
	return prev ? prev.dataset.placeholder || layoutKey(prev) : null;
}

// Folds a closing row (or fades a closing card) right away; the render afterwards slides the neighbours up.
function collapseNode(node, kind)
{
	const done = () => render();
	if (!canAnimate())
	{
		done();
		return;
	}
	const keyframes = kind === 'window'
		? [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }]
		: [{ opacity: 1, height: `${node.offsetHeight}px` }, { opacity: 0, height: '0px' }];
	node.style.overflow = 'hidden';
	node.animate(keyframes, COLLAPSE_ANIMATION).finished.then(done, done);
}

/**
 * Closes tabs: their rows fold away at once and a small "Tab closed. Undo"
 * tip points at the gap. Undo of a single tab restores it from Firefox's
 * recently closed list, with its history.
 */
function closeTabsWithUndo(ids)
{
	const rows = ids.map(id => document.querySelector(`#windows .tab-row[data-tab-id="${id}"]`)).filter(Boolean);
	const anchor = rows[0]?.getBoundingClientRect();
	for (const id of ids)
	{
		state.closing.add(`t${id}`);
		state.selection.delete(id);
	}
	updateSelectionUi();

	const entryPromise = run(async () =>
	{
		await removeTabs(ids);
		return ids.length === 1 ? closedSession('tab') : null;
	}, plural(ids.length, 'Close Tab', 'Close # Tabs'), { quiet: true });
	reopenIfNotClosed(entryPromise, ids.map(id => `t${id}`));

	// All rows are marked as closing first, so a ghost returns after the nearest row that stays.
	const records = rows.map(row => ({
		kind: 'tab',
		key: `pt${row.dataset.tabId}`,
		scopeId: Number(row.closest('.card').dataset.windowId),
		after: previousKey(row),
		original: row.cloneNode(true),
		entryPromise,
	}));
	for (const row of rows)
	{
		collapseNode(row, 'tab');
	}
	if (anchor)
	{
		showUndoTip(anchor, 'tab', plural(ids.length, 'Tab closed.', '# tabs closed.'), records, entryPromise);
	}
}

// Same for a whole window; windows with many tabs ask first.
async function closeWindowWithUndo(windowId)
{
	const win = getWindow(windowId);
	if (!win)
	{
		return;
	}
	const title = win.name || `Window ${win.number}`;
	if (win.tabs.length > closeWindowConfirmLimit() && !await confirmDialog(`Close ${title} and its ${win.tabs.length} tabs?`, 'Close Window'))
	{
		return;
	}
	const card = document.querySelector(`#windows .card[data-window-id="${windowId}"]`);
	if (!card)
	{
		return;
	}
	const anchor = card.getBoundingClientRect();
	state.closing.add(`w${windowId}`);
	state.selectedWindows.delete(windowId);
	updateSelectionUi();

	const entryPromise = run(async () =>
	{
		await browser.windows.remove(windowId);
		return closedSession('window', windowId);
	}, 'Close Window', { quiet: true });
	reopenIfNotClosed(entryPromise, [`w${windowId}`]);

	const record = { kind: 'window', key: `pw${windowId}`, scopeId: null, after: previousKey(card), original: card.cloneNode(true), entryPromise };
	collapseNode(card, 'window');
	showUndoTip(anchor, 'window', `${title} closed.`, [record], entryPromise);
}

// If closing failed (nothing was recorded), show the tabs or window again.
function reopenIfNotClosed(entryPromise, keys)
{
	entryPromise.then(entry =>
	{
		if (!entry)
		{
			keys.forEach(key => state.closing.delete(key));
			render();
		}
	});
}

/**
 * The tip sits just above the gap, its arrow pointing down at it, for a few
 * seconds (paused while hovered). One at a time: a newer close replaces it,
 * and Ctrl+Z still undoes after it is gone.
 */
function showUndoTip(rect, kind, label, records, entryPromise)
{
	hideUndoTip();
	const undoButton = el('button', { class: 'link-button', type: 'button', text: 'Undo' });
	// Not a live region: the action itself is announced (with the Ctrl+Z hint) when it completes.
	const tip = el('div', { class: 'undo-tip' }, el('span', { text: label }), undoButton);
	document.body.append(tip);

	// Right edge just before the "..." button (row: "..." and close, 56px; card: "..." and padding, 40px).
	const width = tip.offsetWidth;
	const rightEdge = rect.right - (kind === 'window' ? 44 : 60);
	const left = Math.max(8, Math.min(rightEdge - width, document.documentElement.clientWidth - width - 8));
	const pointAt = Math.max(left + 16, rightEdge - 20);
	tip.style.left = `${left + scrollX}px`;
	tip.style.top = `${rect.top + scrollY - tip.offsetHeight - 8}px`;
	tip.style.setProperty('--arrow-x', `${pointAt - left}px`);

	const current = { tip, entryPromise, timer: null };
	const startTimer = delay => current.timer = setTimeout(hideUndoTip, delay);
	tip.addEventListener('mouseenter', () => clearTimeout(current.timer));
	tip.addEventListener('mouseleave', () => startTimer(2000));
	undoButton.addEventListener('click', () =>
	{
		hideUndoTip();
		undoClosed(records, entryPromise);
	});
	undoTip = current;
	startTimer(undoTipMs());
}

function hideUndoTip()
{
	if (!undoTip)
	{
		return;
	}
	const { tip, timer } = undoTip;
	undoTip = null;
	clearTimeout(timer);
	if (canAnimate())
	{
		tip.animate({ opacity: [1, 0] }, { duration: 120, easing: 'ease-in', fill: 'forwards' }).finished.then(() => tip.remove(), () => tip.remove());
	}
	else
	{
		tip.remove();
	}
}

// Shows the old rows or card again at once; the restored ones take their place once they exist.
function undoClosed(records, entryPromise)
{
	for (const record of records)
	{
		state.placeholders.set(record.key, record);
	}
	render();
	entryPromise.then(entry =>
	{
		if (entry)
		{
			undoEntry(entry);
			return;
		}
		records.forEach(record => state.placeholders.delete(record.key));
		render();
		showToast('This can no longer be undone', true);
	});
}

/**
 * Called by history.js after an entry was undone, by any route: its ghosts
 * and tip go away, and restored tabs and windows (new ids) inherit the layout
 * keys of their ghosts.
 */
function onEntryUndone(entry)
{
	for (const id of entry.before.tabs.keys())
	{
		if (!entry.after.tabs.has(id) && resolveTab(id) !== id)
		{
			state.keyAliases.set(`t${resolveTab(id)}`, `t${id}`);
		}
	}
	for (const id of entry.before.names.keys())
	{
		if (!entry.after.names.has(id) && resolveWindow(id) !== id)
		{
			state.keyAliases.set(`w${resolveWindow(id)}`, `w${id}`);
		}
	}
	const tip = undoTip;
	tip?.entryPromise.then(tipEntry =>
	{
		if (tipEntry === entry && undoTip === tip)
		{
			hideUndoTip();
		}
	});
	for (const [key, placeholder] of state.placeholders)
	{
		placeholder.entryPromise.then(placeholderEntry =>
		{
			if (placeholderEntry === entry && state.placeholders.delete(key))
			{
				render();
			}
		});
	}
}

// Polite screen reader announcement. Clearing first makes a repeated message be read again.
function announce(text)
{
	const region = $('#announcer');
	region.textContent = '';
	requestAnimationFrame(() => { region.textContent = text; });
}

/* Search */

const SEARCH_DELAY = 80;
let searchTimer = null;
const fuzzyTexts = new WeakMap();

/**
 * Every word must occur in the title or address. Words of 4+ letters also
 * match with a few typos (see allowedTypos) in the title or host name, so
 * "frigde" finds "fridge" and "refridgerator". Typos are not matched against
 * the full address: its random-looking ids would match almost anything.
 */
function searchFilter(query)
{
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length)
	{
		return null;
	}
	return tab =>
	{
		const title = (tab.title || '').toLowerCase();
		const url = (tab.url || '').toLowerCase();
		return terms.every(term => title.includes(term) || url.includes(term) || fuzzyIncludes(fuzzyText(tab), term, allowedTypos(term)));
	};
}

function fuzzyText(tab)
{
	let text = fuzzyTexts.get(tab);
	if (text == null)
	{
		text = `${(tab.title || '').toLowerCase()} ${hostOf(tab.url || '').toLowerCase()}`;
		fuzzyTexts.set(tab, text);
	}
	return text;
}

// 1-3 letters: exact; 4-7: one typo; 8: two; 9+: three ("bootstrap" finds "bootratp").
function allowedTypos(term)
{
	return term.length < 4 ? 0 : term.length < 8 ? 1 : term.length < 9 ? 2 : 3;
}

/**
 * True when `pattern` occurs somewhere in `text` with at most `maxErrors`
 * typos: a letter inserted, removed, replaced, or two neighbouring letters
 * swapped. This is Sellers' algorithm, an edit distance in which the match
 * may start anywhere in the text, computed one text column at a time.
 */
function fuzzyIncludes(text, pattern, maxErrors)
{
	const m = pattern.length;
	if (!maxErrors || m > 64)
	{
		return false;
	}
	let older = new Int32Array(m + 1);
	let prev = new Int32Array(m + 1);
	let cur = new Int32Array(m + 1);
	for (let i = 0; i <= m; i++)
	{
		prev[i] = i;
	}
	for (let j = 1; j <= text.length; j++)
	{
		const c = text.charCodeAt(j - 1);
		cur[0] = 0;
		for (let i = 1; i <= m; i++)
		{
			const p = pattern.charCodeAt(i - 1);
			let value = Math.min(prev[i - 1] + (p === c ? 0 : 1), prev[i] + 1, cur[i - 1] + 1);
			if (i > 1 && j > 1 && p === text.charCodeAt(j - 2) && pattern.charCodeAt(i - 2) === c)
			{
				value = Math.min(value, older[i - 2] + 1);
			}
			cur[i] = value;
		}
		if (cur[m] <= maxErrors)
		{
			return true;
		}
		[older, prev, cur] = [prev, cur, older];
	}
	return false;
}

function setQuery(value)
{
	state.query = value;
	updateSearchClear();
	clearTimeout(searchTimer);
	if (!value.trim())
	{
		clearSearch();
		return;
	}
	searchTimer = setTimeout(() => render({ animate: false }), SEARCH_DELAY);
}

function updateSearchClear()
{
	$('#search-clear').hidden = !$('#search').value;
}

/**
 * Clears the search and keeps the selected tabs in view: their card and
 * group are expanded, "Show more" is opened when needed, and the first one
 * is scrolled to and highlighted. Select a match, press Esc, see its neighbours.
 */
function clearSearch()
{
	clearTimeout(searchTimer);
	state.storedClosedInSearch = false;
	// The query shown on screen, not state.query: when the text was just deleted, the view is still filtered.
	const wasFiltered = !!state.renderedQuery.trim();
	$('#search').value = '';
	state.query = '';
	updateSearchClear();
	if (!wasFiltered)
	{
		return;
	}
	const ids = orderIds(state.selection);
	revealTabs(ids);
	render({ animate: false });
	highlightTabs(ids);
}

function showInContext(tabId)
{
	state.selection = new Set([tabId]);
	state.selectionAnchor = tabId;
	clearSearch();
}

// Expands what is needed (card, group, "Show more") for the tabs to be rendered.
function revealTabs(ids)
{
	for (const tab of tabsOf(ids))
	{
		const win = getWindow(tab.windowId);
		if (!win)
		{
			continue;
		}
		state.collapsedWindows.delete(win.id);
		state.collapsedGroups.delete(groupIdOf(tab));
		if (!tab.pinned && !isExpanded(win.id))
		{
			const rows = windowRows(win).filter(row => !(state.sort === 'order' && state.collapsedGroups.has(groupIdOf(row))));
			if (rows.findIndex(row => row.id === tab.id) >= MAX_ROWS)
			{
				toggleExpanded(win.id);
			}
		}
	}
}

function toggleExpanded(cardId)
{
	state.expandedWindows.has(cardId) ? state.expandedWindows.delete(cardId) : state.expandedWindows.add(cardId);
}

function highlightTabs(ids)
{
	const nodes = ids.map(id => document.querySelector(`#windows [data-tab-id="${id}"]`)).filter(Boolean);
	nodes[0]?.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
	for (const node of nodes)
	{
		node.classList.remove('flash');
		void node.offsetWidth;
		node.classList.add('flash');
	}
}

// Card frame shared by windows and stored tab sets.
function renderCardShell({ title, meta, collapsed, menuTitle })
{
	return el('section', { class: 'card' + (collapsed ? ' collapsed' : '') },
		el('header', { class: 'card-header' },
			el('button', { class: 'icon-button twisty', type: 'button', title: collapsed ? 'Expand' : 'Collapse', 'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${title}`, 'aria-expanded': String(!collapsed), icon: 'chevron' }),
			el('h2', { text: title }),
			meta ? el('span', { class: 'card-meta', text: meta }) : null,
			el('button', { class: 'icon-button more card-more', type: 'button', title: menuTitle, 'aria-label': `${menuTitle}: ${title}`, 'aria-haspopup': 'menu', icon: 'more' }),
		),
	);
}

function isExpanded(cardId)
{
	return state.expandAll !== state.expandedWindows.has(cardId);
}

function renderShowMore(cardId, hiddenCount)
{
	const expanded = isExpanded(cardId);
	return el('div', { class: 'show-more-row' },
		el('button', { class: 'link-button show-more', type: 'button', text: expanded ? 'Show less' : 'Show more' }),
		!expanded && hiddenCount > 0 ? el('span', { class: 'show-more-count', text: `(${hiddenCount})` }) : null,
	);
}

function renderStored(set, filter)
{
	let items = set.items;
	if (filter)
	{
		items = items
			.map(item => item.type === 'group' ? { ...item, tabs: item.tabs.filter(filter) } : item)
			.filter(item => item.type === 'group' ? item.tabs.length : filter(item));
		if (!items.length)
		{
			return null;
		}
	}

	const collapsed = state.collapsedWindows.has(set.id);
	const card = renderCardShell({ title: set.title, meta: plural(set.count, '1 tab', '# tabs'), collapsed, menuTitle: 'Stored tabs options' });
	card.dataset.storedId = set.id;
	if (collapsed)
	{
		return card;
	}

	const limit = filter || isExpanded(set.id) ? Infinity : MAX_ROWS;
	const list = el('ul', { class: 'tab-list', role: 'listbox', 'aria-label': `Stored tabs: ${set.title}` });
	let shown = 0;
	for (const item of items)
	{
		if (shown >= limit)
		{
			break;
		}
		if (item.type === 'tab')
		{
			list.append(renderStoredTab(item, false));
			shown++;
			continue;
		}
		list.append(el('li', { class: 'group-header stored-group', style: { '--group-color': groupColor('grey') } },
			el('span', { class: 'group-label' + (item.title ? '' : ' unnamed'), text: item.title || 'Unnamed group' }),
			el('span', { class: 'group-count', text: plural(item.tabs.length, '1 tab', '# tabs') }),
		));
		for (const tab of item.tabs.slice(0, limit - shown))
		{
			list.append(renderStoredTab(tab, true));
			shown++;
		}
	}

	const body = el('div', { class: 'card-body' }, list);
	if (!filter && set.count > MAX_ROWS)
	{
		body.append(renderShowMore(set.id, set.count - shown));
	}
	card.append(body);
	return card;
}

function renderStoredTab(tab, grouped)
{
	const favicon = state.favicons[hostOf(tab.url)];
	const img = renderFavicon({ favIconUrl: favicon });
	return el('li', {
		class: 'tab-row stored-row' + (grouped ? ' grouped indented' : ''),
		role: 'option',
		tabindex: '-1',
		'aria-label': tab.title,
		draggable: 'true',
		title: `${tab.title}\n${tab.url}\nDouble-click to open, or drag into a window`,
		dataset: { bookmarkId: tab.id },
		style: grouped ? { '--group-color': groupColor('grey') } : {},
	},
		img,
		el('span', { class: 'title', text: tab.title }),
		el('button', { class: 'icon-button close', type: 'button', title: 'Remove from stored tabs', tabindex: '-1', 'aria-hidden': 'true', icon: 'close' }),
	);
}

function renderFavicon(tab)
{
	// Other extensions' pages: their icons are usually not loadable from here, so show a generic extension icon.
	const fallback = (tab.url || '').startsWith('moz-extension:') ? EXTENSION_FAVICON : DEFAULT_FAVICON;
	// Lazy: with thousands of tabs only icons near the screen load. No referrer is sent to the icon's site.
	const img = el('img', { class: 'favicon', alt: '', draggable: 'false', loading: 'lazy', referrerpolicy: 'no-referrer', src: tab.favIconUrl || fallback });
	// chrome:// icons and broken URLs cannot be loaded from an extension page.
	img.addEventListener('error', () => { img.src = fallback; }, { once: true });
	return img;
}

function renderPinned(tab)
{
	return el('button', {
		class: 'pinned-tab' + (state.selection.has(tab.id) ? ' selected' : ''),
		type: 'button',
		role: 'option',
		tabindex: '-1',
		'aria-selected': String(state.selection.has(tab.id)),
		'aria-label': `Pinned: ${tab.title || tab.url}`,
		title: `${tab.title}\n${tab.url}`,
		dataset: { tabId: tab.id },
	}, renderFavicon(tab));
}

function renderTab(tab, orderMode)
{
	const groupId = groupIdOf(tab);
	const group = state.groupsById.get(groupId);
	const muted = !!tab.mutedInfo?.muted;
	const classes = ['tab-row'];
	if (group)
	{
		classes.push('grouped');
		if (orderMode)
		{
			classes.push('indented');
		}
	}
	if (tab.discarded)
	{
		classes.push('discarded');
	}
	if (state.selection.has(tab.id))
	{
		classes.push('selected');
	}

	const states = [tab.pinned && 'pinned', tab.audible && !muted && 'playing audio', muted && 'muted', tab.discarded && 'not loaded', group && `in group ${group.title || 'Unnamed'}`].filter(Boolean);
	const row = el('li', {
		class: classes.join(' '),
		role: 'option',
		tabindex: '-1',
		'aria-selected': String(state.selection.has(tab.id)),
		'aria-label': [tab.title || tab.url, ...states].join(', '),
		draggable: tab.pinned ? null : 'true',
		title: `${tab.title}\n${tab.url}`,
		dataset: { tabId: tab.id },
		style: group ? { '--group-color': groupColor(group.color) } : {},
	},
		renderFavicon(tab),
		el('span', { class: 'title', text: tab.title || tab.url }),
	);

	if (tab.audible || muted)
	{
		row.append(el('button', { class: 'icon-button audio', type: 'button', title: muted ? 'Unmute tab' : 'Mute tab', tabindex: '-1', 'aria-hidden': 'true', icon: muted ? 'muted' : 'audio' }));
	}
	row.append(
		el('button', { class: 'icon-button more', type: 'button', title: 'More options', tabindex: '-1', 'aria-hidden': 'true', icon: 'more' }),
		el('button', { class: 'icon-button close', type: 'button', title: 'Close tab', tabindex: '-1', 'aria-hidden': 'true', icon: 'close' }),
	);
	return row;
}

function renderGroupHeader(groupId, win)
{
	const group = state.groupsById.get(groupId);
	const count = win.tabs.filter(tab => groupIdOf(tab) === groupId).length;
	const collapsed = state.collapsedGroups.has(groupId);
	const title = group?.title || '';

	return el('li', {
		class: 'group-header' + (collapsed ? ' collapsed' : ''),
		draggable: 'true',
		role: 'option',
		tabindex: '-1',
		'aria-selected': 'false',
		'aria-label': `Group ${title || 'Unnamed group'}, ${plural(count, '1 tab', '# tabs')}, ${collapsed ? 'collapsed' : 'expanded'}`,
		dataset: { groupId },
		style: { '--group-color': groupColor(group?.color) },
	},
		el('button', { class: 'icon-button twisty', type: 'button', title: collapsed ? 'Expand' : 'Collapse', tabindex: '-1', 'aria-hidden': 'true', icon: 'chevron' }),
		el('span', { class: 'group-label' + (title ? '' : ' unnamed'), text: title || 'Unnamed group' }),
		el('span', { class: 'group-count', text: plural(count, '1 tab', '# tabs') + (group?.collapsed ? ' · collapsed in tab bar' : '') }),
		el('button', { class: 'icon-button more', type: 'button', title: 'Group options', tabindex: '-1', 'aria-hidden': 'true', icon: 'more' }),
	);
}

/* Selection */

function visibleTabIds()
{
	return [...document.querySelectorAll('#windows [data-tab-id]')].map(node => Number(node.dataset.tabId));
}

function updateSelectionUi()
{
	for (const node of document.querySelectorAll('#windows [data-tab-id]'))
	{
		const selected = state.selection.has(Number(node.dataset.tabId));
		node.classList.toggle('selected', selected);
		node.setAttribute('aria-selected', String(selected));
	}
	for (const node of document.querySelectorAll('#windows .card[data-window-id]'))
	{
		node.classList.toggle('selected-window', state.selectedWindows.has(Number(node.dataset.windowId)));
	}

	const parts = [];
	if (state.selection.size)
	{
		parts.push(plural(state.selection.size, '1 tab', '# tabs'));
	}
	if (state.selectedWindows.size)
	{
		parts.push(plural(state.selectedWindows.size, '1 window', '# windows'));
	}
	$('#selection-info').hidden = !parts.length;
	$('#selection-count').textContent = parts.join(', ') + ' selected';
}

function clearSelection()
{
	state.selection.clear();
	state.selectedWindows.clear();
	state.selectionAnchor = null;
	updateSelectionUi();
}

function toggleWindowSelected(windowId)
{
	if (state.selectedWindows.has(windowId))
	{
		state.selectedWindows.delete(windowId);
	}
	else
	{
		state.selectedWindows.add(windowId);
	}
	updateSelectionUi();
}

function toggleSelected(tabId)
{
	if (state.selection.has(tabId))
	{
		state.selection.delete(tabId);
	}
	else
	{
		state.selection.add(tabId);
	}
	state.selectionAnchor = tabId;
	updateSelectionUi();
}

function selectOnly(tabId)
{
	state.selection = new Set([tabId]);
	state.selectionAnchor = tabId;
	updateSelectionUi();
}

function selectRange(tabId, add)
{
	const ids = visibleTabIds();
	const end = ids.indexOf(tabId);
	let start = ids.indexOf(state.selectionAnchor);
	if (start < 0)
	{
		start = end;
		state.selectionAnchor = tabId;
	}
	if (!add)
	{
		state.selection.clear();
	}
	for (const id of ids.slice(Math.min(start, end), Math.max(start, end) + 1))
	{
		state.selection.add(id);
	}
	updateSelectionUi();
}

/* Tab operations */

async function activateTab(tabId)
{
	const tab = await browser.tabs.update(tabId, { active: true });
	await browser.windows.update(tab.windowId, { focused: true });
}

// Opens a copy (with its history) next to the TabCentral tab; the original stays where it is.
async function copyTabHere(tabId)
{
	const self = await browser.tabs.getCurrent();
	const copy = await browser.tabs.duplicate(tabId, { active: false });
	if (copy.pinned)
	{
		await movePinnedTab(copy.id, self.windowId);
	}
	else
	{
		await browser.tabs.move(copy.id, { windowId: self.windowId, index: self.index + 1 });
	}
	await activateTab(copy.id);
}

// Moves a tab next to the TabCentral tab and switches to it.
async function openTabHere(tabId)
{
	const self = await browser.tabs.getCurrent();
	const tab = await browser.tabs.get(tabId);
	if (tab.windowId === self.windowId)
	{
		// Already in this window: just switch to it.
	}
	else if (tab.pinned)
	{
		await movePinnedTab(tabId, self.windowId);
	}
	else
	{
		await browser.tabs.move(tabId, { windowId: self.windowId, index: self.index + 1 });
	}
	await activateTab(tabId);
}

/**
 * Moves tabs one by one so that each ends up directly before the anchor tab,
 * or at the end of windowId when anchorId is null. Positions are re-read for
 * every tab, so earlier moves and concurrent changes do not skew the index.
 */
async function moveTabs(ids, windowId, anchorId)
{
	// Appending needs no position bookkeeping, so move all tabs in one call (fast for large batches).
	if (anchorId == null)
	{
		if (ids.length)
		{
			await browser.tabs.move(ids, { windowId, index: -1 });
		}
		return;
	}

	for (const id of ids)
	{
		if (id === anchorId)
		{
			continue;
		}

		let [tab, anchor] = await Promise.all([browser.tabs.get(id), browser.tabs.get(anchorId)]);
		const index = tab.windowId === anchor.windowId && tab.index < anchor.index ? anchor.index - 1 : anchor.index;
		await browser.tabs.move(id, { windowId: anchor.windowId, index });

		// Guard against index semantics differing for same-window moves: correct once if not adjacent.
		[tab, anchor] = await Promise.all([browser.tabs.get(id), browser.tabs.get(anchorId)]);
		if (tab.windowId === anchor.windowId && tab.index !== anchor.index - 1)
		{
			await browser.tabs.move(id, { index: anchor.index });
		}
	}
}

async function moveToNewWindow(ids)
{
	const win = await browser.windows.create({ tabId: ids[0] });
	await moveTabs(ids.slice(1), win.id, null);
	await refocusSelf();
	return win;
}

// Creating a window focuses it; bring the window with this page back to the front.
async function refocusSelf()
{
	const self = await browser.tabs.getCurrent();
	if (self)
	{
		await browser.windows.update(self.windowId, { focused: true });
	}
}

// Like refocusSelf, and also makes this tab the active tab of its window again.
async function bringSelfToFront()
{
	const self = await browser.tabs.getCurrent();
	if (self)
	{
		await browser.tabs.update(self.id, { active: true });
		await browser.windows.update(self.windowId, { focused: true });
	}
}

async function moveToEdge(ids, edge)
{
	const moving = new Set(ids);
	const byWindow = new Map();
	for (const tab of tabsOf(ids))
	{
		if (!byWindow.has(tab.windowId))
		{
			byWindow.set(tab.windowId, []);
		}
		byWindow.get(tab.windowId).push(tab.id);
	}

	for (const [windowId, windowIds] of byWindow)
	{
		if (edge === 'end')
		{
			await moveTabs(windowIds, windowId, null);
			continue;
		}
		const fresh = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
		const anchor = fresh.find(tab => !tab.pinned && !moving.has(tab.id));
		await moveTabs(windowIds, windowId, anchor ? anchor.id : null);
	}
}

// Puts the tabs into groupId, or takes them out of any group for NO_GROUP.
async function setGroup(ids, groupId)
{
	if (!HAS_GROUPS || !ids.length)
	{
		return;
	}
	if (groupId !== NO_GROUP)
	{
		await browser.tabs.group({ groupId, tabIds: ids });
		return;
	}
	const fresh = await Promise.all(ids.map(id => browser.tabs.get(id)));
	const grouped = fresh.filter(tab => groupIdOf(tab) !== NO_GROUP).map(tab => tab.id);
	if (grouped.length)
	{
		await browser.tabs.ungroup(grouped);
	}
}

/**
 * Closes the tabs that still exist. Ids come from a snapshot that can be a
 * moment old, and tabs.remove rejects the whole call for one unknown id.
 */
async function removeTabs(ids)
{
	const existing = new Set((await browser.tabs.query({})).map(tab => tab.id));
	const live = ids.filter(id => existing.has(id));
	if (live.length)
	{
		await browser.tabs.remove(live);
	}
}

async function setMuted(ids, muted)
{
	await Promise.all(ids.map(id => browser.tabs.update(id, { muted })));
}

async function copyLinks(ids)
{
	const urls = tabsOf(ids).map(tab => tab.url);
	await navigator.clipboard.writeText(urls.join('\n'));
	showToast(plural(urls.length, 'Link copied', '# links copied'));
}

/* Windows */

async function movePinnedTab(tabId, windowId)
{
	const pinnedCount = (await browser.tabs.query({ windowId, pinned: true })).length;
	try
	{
		await browser.tabs.move(tabId, { windowId, index: pinnedCount });
	}
	catch (err)
	{
		// Fallback in case a pinned tab cannot be moved across windows directly.
		await browser.tabs.update(tabId, { pinned: false });
		await browser.tabs.move(tabId, { windowId, index: -1 });
		await browser.tabs.update(tabId, { pinned: true });
	}
}

/**
 * Moves all tabs of the source windows to the end of the target window,
 * keeping their order, pinned state and tab groups (groups move as a whole).
 */
async function mergeWindows(sourceIds, targetId)
{
	for (const sourceId of sourceIds)
	{
		if (sourceId === targetId)
		{
			continue;
		}
		const tabs = (await browser.tabs.query({ windowId: sourceId })).sort((a, b) => a.index - b.index);
		const movedGroups = new Set();
		let batch = [];
		const flush = async () =>
		{
			if (batch.length)
			{
				await browser.tabs.move(batch, { windowId: targetId, index: -1 });
				batch = [];
			}
		};

		for (const tab of tabs)
		{
			const groupId = groupIdOf(tab);
			if (!tab.pinned && groupId === NO_GROUP)
			{
				batch.push(tab.id);
				continue;
			}
			await flush();
			if (tab.pinned)
			{
				await movePinnedTab(tab.id, targetId);
			}
			else if (!movedGroups.has(groupId))
			{
				movedGroups.add(groupId);
				await browser.tabGroups.move(groupId, { windowId: targetId, index: -1 });
			}
		}
		await flush();
	}
	state.selectedWindows.clear();
}

// Address sort ignores the scheme and "www.", so tabs of one site end up together.
function addressKey(url)
{
	return (url || '').replace(/^[a-z][a-z0-9+.-]*:\/*(www\.)?/i, '').toLowerCase();
}

/**
 * Physically reorders the unpinned tabs of a window. Groups stay together:
 * they come first in their current order, each sorted internally, followed
 * by the ungrouped tabs. Groups are dissolved while reordering and recreated
 * with the same title, color and collapsed state, so moves cannot pull tabs
 * into or out of a group by accident.
 */
/**
 * Title used for sorting: leading notification counters such as "(6) " or
 * "[3] " and leading symbols or emoji are ignored, so "(6) Fireship - YouTube"
 * sorts under F. Digits that belong to the title ("2001: A Space Odyssey")
 * and non-Latin letters are kept.
 */
function titleSortKey(title)
{
	// Counters have at most three digits ("(99+)"), so a year like "(2024) Movie" is kept.
	return (title || '').replace(/^\s*(?:[([]\d{1,3}\+?[)\]]\s*)+/, '').replace(/^[^\p{L}\p{N}]+/u, '');
}

function tabComparator(by)
{
	const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
	const key = tab => by === 'title' ? titleSortKey(tab.title) : addressKey(tab.url);
	return (a, b) => collator.compare(key(a), key(b));
}

async function sortWindow(windowId, by)
{
	const compare = tabComparator(by);

	const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
	const pinnedCount = tabs.filter(tab => tab.pinned).length;
	const groups = new Map();
	const loose = [];
	for (const tab of tabs.filter(tab => !tab.pinned))
	{
		const groupId = groupIdOf(tab);
		if (groupId === NO_GROUP)
		{
			loose.push(tab);
			continue;
		}
		if (!groups.has(groupId))
		{
			groups.set(groupId, { info: state.groupsById.get(groupId) || await browser.tabGroups.get(groupId), tabs: [] });
		}
		groups.get(groupId).tabs.push(tab);
	}
	for (const group of groups.values())
	{
		group.tabs.sort(compare);
	}
	loose.sort(compare);
	const desired = [...[...groups.values()].flatMap(group => group.tabs), ...loose].map(tab => tab.id);

	const groupedIds = [...groups.values()].flatMap(group => group.tabs.map(tab => tab.id));
	if (groupedIds.length)
	{
		await browser.tabs.ungroup(groupedIds);
	}

	// Working left to right, every tab only moves left, which keeps target indexes unambiguous.
	const current = (await browser.tabs.query({ windowId, pinned: false })).sort((a, b) => a.index - b.index).map(tab => tab.id);
	for (let i = 0; i < desired.length; i++)
	{
		const at = current.indexOf(desired[i]);
		if (at === i || at < 0)
		{
			continue;
		}
		await browser.tabs.move(desired[i], { index: pinnedCount + i });
		current.splice(at, 1);
		current.splice(i, 0, desired[i]);
	}

	for (const { info, tabs: groupTabs } of groups.values())
	{
		const groupId = await browser.tabs.group({ tabIds: groupTabs.map(tab => tab.id), createProperties: { windowId } });
		await browser.tabGroups.update(groupId, { title: info?.title || '', color: info?.color || 'grey', collapsed: !!info?.collapsed });
	}
}

/* Stored tabs */

function hostOf(url)
{
	try
	{
		return new URL(url).host;
	}
	catch (err)
	{
		return '';
	}
}

// Extensions may only (re)open web pages; anything else is never stored or closed by "Store Tabs as".
function canStore(url)
{
	return /^(https?|ftp):/i.test(url || '');
}

function timestampTitle()
{
	const now = new Date();
	const pad = n => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// Bookmarks carry no favicon, so remember small ones per host for the stored tabs list.
function rememberFavicons(tabs)
{
	for (const tab of tabs)
	{
		const host = hostOf(tab.url);
		const icon = tab.favIconUrl;
		if (!host || !icon || icon.length > MAX_FAVICON_LENGTH || !/^(https:|data:image\/)/.test(icon))
		{
			continue;
		}
		delete state.favicons[host];
		state.favicons[host] = icon;
	}
	const hosts = Object.keys(state.favicons);
	for (const host of hosts.slice(0, Math.max(0, hosts.length - MAX_FAVICONS)))
	{
		delete state.favicons[host];
	}
	writePref(FAVICON_KEY, JSON.stringify(state.favicons));
}

/**
 * Stores the tabs as bookmarks in a new folder named `title`, then closes them.
 * Tabs are only closed after all bookmarks were created. Tabs that cannot be
 * reopened by an extension (about:, file:, ...) stay open.
 */
async function storeTabs(ids, title)
{
	const tabs = tabsOf(orderIds(ids));
	const toStore = tabs.filter(tab => canStore(tab.url));
	const empty = tabs.filter(tab => EMPTY_URLS.includes(tab.url));
	const kept = tabs.length - toStore.length - empty.length;
	if (!toStore.length)
	{
		showToast('Nothing to store: none of these tabs can be reopened by an extension');
		return;
	}

	const rootId = await findStoredRoot(true);
	const folder = await browser.bookmarks.create({ parentId: rootId, title: title || timestampTitle(), index: 0 });
	const groupFolders = new Map();
	try
	{
		for (const tab of toStore)
		{
			let parentId = folder.id;
			const groupId = groupIdOf(tab);
			if (groupId !== NO_GROUP)
			{
				if (!groupFolders.has(groupId))
				{
					const title = state.groupsById.get(groupId)?.title || '';
					groupFolders.set(groupId, (await browser.bookmarks.create({ parentId: folder.id, title })).id);
				}
				parentId = groupFolders.get(groupId);
			}
			await browser.bookmarks.create({ parentId, title: tab.title || tab.url, url: tab.url });
		}
	}
	catch (err)
	{
		// Roll back the half-written folder; the tabs stay open.
		await browser.bookmarks.removeTree(folder.id).catch(console.error);
		throw err;
	}

	rememberFavicons(toStore);
	const closedIds = [...toStore, ...empty].map(tab => tab.id);
	await removeTabs(closedIds);
	showToast(plural(toStore.length, 'Stored 1 tab', 'Stored # tabs')
		+ (kept ? ` (${plural(kept, '1 tab', '# tabs')} cannot be reopened by an extension and stayed open)` : ''));

	// Lets undo remove the folder again and redo store the same tabs.
	return { storedFolderId: folder.id, title: folder.title, storedIds: closedIds };
}

function truncate(text, length)
{
	return text.length > length ? text.slice(0, length - 1).trimEnd() + '…' : text;
}

// "Store Tabs as" submenu: window name (if the tabs share a named window), date, first tab title, or a custom name.
function storeSubmenu(ids)
{
	const tabs = tabsOf(orderIds(ids)).filter(tab => canStore(tab.url));
	if (!tabs.length)
	{
		return [];
	}
	const date = timestampTitle();
	const firstTitle = truncate(tabs[0].title || tabs[0].url, 80);
	const windowIds = new Set(tabs.map(tab => tab.windowId));
	const sharedName = windowIds.size === 1 ? getWindow([...windowIds][0])?.name : '';

	const items = [];
	if (sharedName)
	{
		items.push({ label: sharedName, action: () => storeTabs(ids, sharedName) });
	}
	items.push(
		{ label: date, action: () => storeTabs(ids, date) },
		{ label: firstTitle, action: () => storeTabs(ids, firstTitle) },
		'-',
		{
			label: 'Custom Name…',
			action: async () =>
			{
				const name = await promptDialog({ heading: 'Store tabs as', label: 'Folder name', value: sharedName || date, okLabel: 'Store' });
				if (name)
				{
					await storeTabs(ids, name);
				}
			},
		},
	);
	return items;
}

/**
 * Reopens a stored set as discarded tabs (they load when first selected) and
 * recreates its groups. The bookmarks are only removed if every tab opened.
 */
async function restoreStored(setId, where)
{
	const set = state.stored.find(item => item.id === setId);
	if (!set)
	{
		return;
	}
	if (!set.count)
	{
		// Nothing to open (e.g. emptied by hand in the bookmarks library); don't leave an empty window.
		await browser.bookmarks.removeTree(set.id);
		return;
	}

	let windowId;
	let blankIds = [];
	if (where === 'new')
	{
		const win = await browser.windows.create({});
		windowId = win.id;
		blankIds = (win.tabs || []).map(tab => tab.id);
		// A set stored under a real name gives its window that name back; dates are not useful as names.
		if (HAS_SESSIONS && set.title && !DATE_TITLE.test(set.title))
		{
			await setWindowName(windowId, set.title);
		}
	}
	else
	{
		windowId = (await browser.windows.getCurrent()).id;
	}

	let failed = 0;
	let colorIndex = 0;
	const open = async tab =>
	{
		try
		{
			return (await browser.tabs.create({ windowId, url: tab.url, title: tab.title, discarded: true, active: false })).id;
		}
		catch (err)
		{
			console.error(tab.url, err);
			failed++;
			return null;
		}
	};

	for (const item of set.items)
	{
		if (item.type === 'tab')
		{
			await open(item);
			continue;
		}
		const ids = [];
		for (const tab of item.tabs)
		{
			const id = await open(tab);
			if (id != null)
			{
				ids.push(id);
			}
		}
		if (ids.length && HAS_GROUPS)
		{
			const groupId = await browser.tabs.group({ tabIds: ids, createProperties: { windowId } });
			// Colors are not stored; cycle through them, skipping grey.
			await browser.tabGroups.update(groupId, { title: item.title, color: GROUP_COLORS[1 + (colorIndex++ % (GROUP_COLORS.length - 1))] });
		}
	}

	if (blankIds.length && failed < set.count)
	{
		await browser.tabs.remove(blankIds);
	}
	if (where === 'new')
	{
		await refocusSelf();
	}
	if (failed)
	{
		showToast(`${plural(failed, '1 tab', '# tabs')} could not be opened, so the stored tabs were kept.`, true);
		return;
	}
	await browser.bookmarks.removeTree(set.id);
}

function findStoredTab(bookmarkId)
{
	for (const set of state.stored)
	{
		for (const item of set.items)
		{
			const found = item.type === 'group' ? item.tabs.find(tab => tab.id === bookmarkId) : item.id === bookmarkId ? item : null;
			if (found)
			{
				return found;
			}
		}
	}
	return null;
}

async function openStoredTab(bookmarkId)
{
	const tab = findStoredTab(bookmarkId);
	if (tab)
	{
		await browser.tabs.create({ url: tab.url, windowId: (await browser.windows.getCurrent()).id, active: false });
		showToast(`Opened “${tab.title}” in the background`);
	}
}

async function removeStoredTab(bookmarkId)
{
	const [node] = await browser.bookmarks.get(bookmarkId);
	await browser.bookmarks.remove(bookmarkId);

	// Remove folders left empty, up to but excluding the Open Tabs folder and the built-in roots.
	const rootId = await findStoredRoot(false);
	let parentId = node.parentId;
	while (parentId && parentId !== rootId && !/_{2,}$/.test(parentId))
	{
		if ((await browser.bookmarks.getChildren(parentId)).length)
		{
			break;
		}
		const [folder] = await browser.bookmarks.get(parentId);
		await browser.bookmarks.remove(parentId);
		parentId = folder.parentId;
	}
}

async function deleteStored(setId)
{
	const set = state.stored.find(item => item.id === setId);
	if (set && await confirmDialog(`Delete the ${plural(set.count, '1 stored tab', '# stored tabs')} from “${set.title}”?`, 'Delete'))
	{
		await browser.bookmarks.removeTree(setId);
	}
}

/**
 * Restores dragged stored tabs (discarded) at a drop target in a window, then
 * removes their bookmarks. Bookmarks are only removed for tabs that opened.
 */
async function restoreStoredAt(bookmarkIds, plan)
{
	const entries = bookmarkIds.map(findStoredTab).filter(Boolean);
	if (!entries.length)
	{
		return;
	}

	let windowId = plan?.windowId;
	let blankIds = [];
	if (!plan)
	{
		const win = await browser.windows.create({});
		windowId = win.id;
		blankIds = (win.tabs || []).map(tab => tab.id);
	}
	const groupId = plan ? plan.groupId : NO_GROUP;

	let index = plan?.anchorId != null ? (await browser.tabs.get(plan.anchorId)).index : null;
	const ids = [];
	for (const entry of entries)
	{
		const props = { windowId, url: entry.url, title: entry.title, discarded: true, active: false };
		if (index != null)
		{
			props.index = index++;
		}
		ids.push((await browser.tabs.create(props)).id);
		await removeStoredTab(entry.id);
	}
	await setGroup(ids, groupId);
	if (blankIds.length)
	{
		await browser.tabs.remove(blankIds);
		await refocusSelf();
	}
}

/* Window names */

async function setWindowName(windowId, name)
{
	name = name.trim().slice(0, 100);
	if (name)
	{
		await browser.sessions.setWindowValue(windowId, WINDOW_NAME_KEY, name);
	}
	else
	{
		await browser.sessions.removeWindowValue(windowId, WINDOW_NAME_KEY);
	}
	await browser.windows.update(windowId, { titlePreface: name ? name + TITLE_PREFACE_SEPARATOR : '' });
	state.prefaced.add(windowId);
}

// Replaces the window title with an input; Enter or leaving the field saves, Escape cancels.
function startRename(windowId)
{
	const win = getWindow(windowId);
	const heading = document.querySelector(`#windows .card[data-window-id="${windowId}"] .card-header h2`);
	if (!win || !heading || !HAS_SESSIONS)
	{
		return;
	}

	const input = el('input', { class: 'rename-input', type: 'text', maxlength: '100', placeholder: `Window ${win.number}`, 'aria-label': 'Window name' });
	input.value = win.name || '';
	heading.replaceWith(input);
	input.focus();
	input.select();
	state.editing = true;

	let done = false;
	const finish = save =>
	{
		if (done)
		{
			return;
		}
		done = true;
		state.editing = false;
		if (save && input.value.trim() !== (win.name || ''))
		{
			run(() => setWindowName(windowId, input.value), 'Rename Window');
		}
		else
		{
			render();
		}
	};
	input.addEventListener('keydown', e =>
	{
		e.stopPropagation();
		if (e.key === 'Enter')
		{
			finish(true);
		}
		else if (e.key === 'Escape')
		{
			finish(false);
		}
	});
	input.addEventListener('blur', () => finish(true));
	input.addEventListener('click', e => e.stopPropagation());
	input.addEventListener('dblclick', e => e.stopPropagation());
}

/* Sites and duplicates */

// Registrable domain of a web URL (sub.mercari.com and mercari.com both give mercari.com), or '' for other URLs.
function siteOf(url)
{
	let host;
	try
	{
		const parsed = new URL(url);
		if (!/^https?:$/.test(parsed.protocol))
		{
			return '';
		}
		host = parsed.hostname;
	}
	catch (err)
	{
		return '';
	}
	if (!host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host))
	{
		return host;
	}
	return registrableDomain(host);
}

/**
 * Moves all unpinned tabs of a site, from every window, in their current
 * order to the end of a window, or into a new window named after the site.
 */
async function moveSiteTabs(site, windowId)
{
	const ids = orderIds([...state.tabsById.values()].filter(tab => !tab.pinned && siteOf(tab.url) === site).map(tab => tab.id));
	if (!ids.length)
	{
		return;
	}
	if (windowId != null)
	{
		await moveTabs(ids, windowId, null);
		return;
	}
	const win = await moveToNewWindow(ids);
	if (HAS_SESSIONS)
	{
		await setWindowName(win.id, site[0].toUpperCase() + site.slice(1));
	}
}

// Moves every group of a window, in order, to its start or end, or into a new window.
async function moveAllGroups(windowId, where)
{
	const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
	const groupIds = [...new Set(tabs.map(groupIdOf).filter(id => id !== NO_GROUP))];
	if (where === 'start')
	{
		// Last group first: each one lands before the groups moved earlier.
		for (const groupId of [...groupIds].reverse())
		{
			await moveGroupToStart(groupId);
		}
		return;
	}
	let targetId = windowId;
	let blankIds = [];
	if (where === 'new')
	{
		const win = await browser.windows.create({});
		targetId = win.id;
		blankIds = (win.tabs || []).map(tab => tab.id);
	}
	for (const groupId of groupIds)
	{
		await browser.tabGroups.move(groupId, { windowId: targetId, index: -1 });
	}
	if (blankIds.length)
	{
		await browser.tabs.remove(blankIds);
		await refocusSelf();
	}
}

function tabsInScope(windowId)
{
	return windowId == null ? [...state.tabsById.values()] : getWindow(windowId)?.tabs || [];
}

/**
 * Ids of tabs whose URL is open more than once. Of each URL it keeps the
 * pinned, then the active, then the most recently used copy. Pinned tabs are
 * never returned.
 */
function duplicateIds(tabs)
{
	const better = (a, b) => (a.pinned - b.pinned) || (a.active - b.active) || ((a.lastAccessed || 0) - (b.lastAccessed || 0));
	const keep = new Map();
	const close = [];
	for (const tab of tabs)
	{
		const kept = keep.get(tab.url);
		if (!kept)
		{
			keep.set(tab.url, tab);
		}
		else if (better(tab, kept) > 0)
		{
			close.push(kept);
			keep.set(tab.url, tab);
		}
		else
		{
			close.push(tab);
		}
	}

	return close.filter(tab => !tab.pinned).map(tab => tab.id);
}

// Closes duplicate tabs in one window, or in all windows for windowId null.
async function closeDuplicates(windowId)
{
	const ids = duplicateIds(tabsInScope(windowId));
	if (!ids.length)
	{
		showToast('No duplicate tabs found');
		return;
	}
	await removeTabs(ids);
	showToast(plural(ids.length, 'Closed 1 duplicate tab', 'Closed # duplicate tabs'));
}

/* Groups */

// A random colour no group uses yet (grey only when chosen by hand), blue when all are taken.
function nextGroupColor()
{
	const used = new Set([...state.groupsById.values()].map(group => group.color));
	const unused = GROUP_COLORS.filter(color => color !== 'grey' && !used.has(color));
	return unused.length ? unused[Math.floor(Math.random() * unused.length)] : 'blue';
}

async function createGroup(ids)
{
	const tabs = tabsOf(ids).filter(tab => !tab.pinned);
	if (!tabs.length)
	{
		return;
	}
	const result = await groupDialog({ heading: 'Create tab group', okLabel: 'Create', title: '', color: nextGroupColor() });
	if (!result)
	{
		return;
	}

	// Tabs from other windows join the window of the first tab.
	const windowId = tabs[0].windowId;
	const foreign = tabs.filter(tab => tab.windowId !== windowId).map(tab => tab.id);
	await moveTabs(foreign, windowId, null);

	const groupId = await browser.tabs.group({ tabIds: tabs.map(tab => tab.id), createProperties: { windowId } });
	await browser.tabGroups.update(groupId, { title: result.title, color: result.color });
}

async function addToGroup(ids, group)
{
	const foreign = tabsOf(ids).filter(tab => tab.windowId !== group.windowId).map(tab => tab.id);
	await moveTabs(foreign, group.windowId, null);
	await browser.tabs.group({ groupId: group.id, tabIds: ids });
}

async function editGroup(groupId)
{
	const group = state.groupsById.get(groupId);
	if (!group)
	{
		return;
	}
	const result = await groupDialog({ heading: 'Edit tab group', okLabel: 'Save', title: group.title || '', color: group.color });
	if (result)
	{
		await browser.tabGroups.update(groupId, { title: result.title, color: result.color });
	}
}

async function groupMembers(groupId)
{
	const group = await browser.tabGroups.get(groupId);
	return (await browser.tabs.query({ windowId: group.windowId })).filter(tab => tab.groupId === groupId).sort((a, b) => a.index - b.index);
}

/**
 * Moves a group so it ends directly before the anchor tab. As with tabs, the
 * index meaning for same-window moves is verified and corrected once.
 */
async function moveGroupBefore(groupId, anchorId)
{
	for (const finalPosition of [true, false])
	{
		const [anchor, members] = await Promise.all([browser.tabs.get(anchorId), groupMembers(groupId)]);
		const before = members[0].windowId === anchor.windowId && members[0].index < anchor.index;
		const index = before && finalPosition ? anchor.index - members.length : anchor.index;
		await browser.tabGroups.move(groupId, { windowId: anchor.windowId, index });

		const [movedAnchor, moved] = await Promise.all([browser.tabs.get(anchorId), groupMembers(groupId)]);
		if (moved.at(-1).windowId === movedAnchor.windowId && moved.at(-1).index === movedAnchor.index - 1)
		{
			return;
		}
	}
}

// Moves a group before the first unpinned tab of its window that is not in the group.
async function moveGroupToStart(groupId)
{
	const members = await groupMembers(groupId);
	const tabs = (await browser.tabs.query({ windowId: members[0].windowId })).sort((a, b) => a.index - b.index);
	const anchor = tabs.find(tab => !tab.pinned && tab.groupId !== groupId);
	if (anchor && anchor.index < members[0].index)
	{
		await moveGroupBefore(groupId, anchor.id);
	}
}

async function moveGroupToNewWindow(groupId)
{
	const win = await browser.windows.create({});
	const blankIds = (win.tabs || []).map(tab => tab.id);
	await browser.tabGroups.move(groupId, { windowId: win.id, index: -1 });
	if (blankIds.length)
	{
		await browser.tabs.remove(blankIds);
	}
	await refocusSelf();
}

async function deleteGroup(groupId)
{
	const ids = tabsInGroup(groupId).map(tab => tab.id);
	if (!ids.length)
	{
		return;
	}
	const ok = await confirmDialog(plural(ids.length, 'Close the tab in this group?', 'Close all # tabs in this group?'), 'Close tabs');
	if (ok)
	{
		await removeTabs(ids);
	}
}

/* Menus */

const openMenus = [];

function closeMenus(fromLevel = 0)
{
	while (openMenus.length > fromLevel)
	{
		openMenus.pop().remove();
	}
}

function openMenu(items, x, y)
{
	closeMenus();
	menuReturnFocus = document.activeElement;
	showMenu(items, 0, { x, y });
	openMenus[0].focus();
}

/**
 * items: [{label, action, submenu, disabled, swatch, history, immediate, hint} | '-']
 * Actions are recorded for undo under "Parent › Label" unless history is false.
 */
function showMenu(items, level, pos, parentLabel = '')
{
	closeMenus(level);
	const menu = el('div', { class: 'menu', role: 'menu', tabindex: '-1' });

	for (const item of items)
	{
		if (item === '-')
		{
			menu.append(el('div', { class: 'menu-separator', role: 'separator' }));
			continue;
		}
		const button = el('button', { class: 'menu-item' + (item.submenu ? ' has-submenu' : ''), type: 'button', role: 'menuitem', disabled: !!item.disabled, title: item.hint || null, 'aria-haspopup': item.submenu ? 'menu' : null },
			item.swatch ? el('span', { class: 'swatch', style: { '--group-color': groupColor(item.swatch) } }) : null,
			el('span', { class: 'menu-label', text: item.label }),
			item.submenu ? el('span', { class: 'menu-arrow', icon: 'arrow' }) : null,
		);

		if (item.submenu)
		{
			const open = () =>
			{
				for (const sibling of menu.querySelectorAll('.menu-item.open'))
				{
					sibling.classList.remove('open');
				}
				button.classList.add('open');
				const rect = button.getBoundingClientRect();
				showMenu(item.submenu, level + 1, { x: rect.right + 2, y: rect.top - 5, flipX: rect.left - 2 }, item.label);
			};
			button.addEventListener('mouseenter', open);
			button.addEventListener('click', open);
		}
		else
		{
			button.addEventListener('mouseenter', () =>
			{
				closeMenus(level + 1);
				menu.querySelector('.menu-item.open')?.classList.remove('open');
			});
			// Actions receive the click event, so they can react to modifier keys.
			button.addEventListener('click', e =>
			{
				closeMenus();
				if (item.immediate)
				{
					// Runs right away, outside the action queue: the clipboard only accepts writes during the click.
					Promise.resolve().then(() => item.action(e)).catch(showError);
					return;
				}
				run(() => item.action(e), item.history === false ? null : (parentLabel ? `${parentLabel} › ${item.label}` : item.label));
			});
		}
		menu.append(button);
	}

	document.body.append(menu);
	placeMenu(menu, pos);
	openMenus.push(menu);
}

function placeMenu(menu, { x, y, flipX })
{
	const { width, height } = menu.getBoundingClientRect();
	if (x + width > innerWidth - 4)
	{
		x = flipX != null ? flipX - width : innerWidth - width - 4;
	}
	if (y + height > innerHeight - 4)
	{
		y = innerHeight - height - 4;
	}
	menu.style.left = `${Math.max(4, x)}px`;
	menu.style.top = `${Math.max(4, y)}px`;
}

function windowSubmenu(currentWindowIds, onWindow)
{
	return state.windows
		.filter(win => !currentWindowIds.every(id => id === win.id))
		.map(win => ({ label: `Move to ${windowName(win)}`, action: () => onWindow(win.id) }));
}

function tabMenuItems(ids)
{
	const tabs = tabsOf(ids);
	const n = tabs.length;
	const movable = tabs.filter(tab => !tab.pinned);
	const movableIds = movable.map(tab => tab.id);
	const allPinned = tabs.every(tab => tab.pinned);
	const allMuted = tabs.every(tab => tab.mutedInfo?.muted);

	const others = windowSubmenu(movable.map(tab => tab.windowId), windowId => moveTabs(movableIds, windowId, null));
	const items = [];
	const here = state.windows.find(win => win.current);
	if (n === 1)
	{
		if (searchFilter(state.renderedQuery))
		{
			items.push({ label: 'Show Tab in Context', immediate: true, action: () => showInContext(tabs[0].id) });
		}
		items.push({ label: 'Open Tab', history: false, action: () => activateTab(tabs[0].id) });
		if (here && tabs[0].windowId !== here.id)
		{
			items.push({
				label: `Open Tab in This Window (${here.name || `Window ${here.number}`})`,
				hint: 'Ctrl+click: open a copy and leave the original where it is',
				action: e => e?.ctrlKey || e?.metaKey ? copyTabHere(tabs[0].id) : openTabHere(tabs[0].id),
			});
		}
		items.push('-');
	}
	items.push({
		label: plural(n, 'Move Tab', 'Move # Tabs'),
		disabled: !movable.length,
		submenu: [
			{ label: 'Move to Start', action: () => moveToEdge(movableIds, 'start') },
			{ label: 'Move to End', action: () => moveToEdge(movableIds, 'end') },
			{ label: 'Move to New Window', action: () => moveToNewWindow(movableIds) },
			...(others.length ? ['-', ...others] : []),
		],
	});

	const sites = new Set(tabs.map(tab => siteOf(tab.url)));
	const site = sites.size === 1 ? [...sites][0] : '';
	if (site)
	{
		const count = [...state.tabsById.values()].filter(tab => !tab.pinned && siteOf(tab.url) === site).length;
		items.push({
			label: `Move All ${site} Tabs (${count})`,
			disabled: !count,
			submenu: [
				{ label: 'Move to New Window', action: () => moveSiteTabs(site, null) },
				'-',
				...state.windows.map(win => ({ label: `Move to ${windowName(win)}`, action: () => moveSiteTabs(site, win.id) })),
			],
		});
	}

	if (HAS_GROUPS)
	{
		const groups = [...state.groupsById.values()];
		items.push({
			label: plural(n, 'Add Tab to Group', 'Add # Tabs to Group'),
			disabled: !movable.length,
			submenu: [
				{ label: 'New Group…', action: () => createGroup(movableIds) },
				...(groups.length ? ['-'] : []),
				...groups.map(group =>
				{
					const win = getWindow(group.windowId);
					const suffix = win && !movable.every(tab => tab.windowId === win.id) ? ` (${windowName(win)})` : '';
					return { label: (group.title || 'Unnamed group') + suffix, swatch: group.color, action: () => addToGroup(movableIds, group) };
				}),
			],
		});
		const grouped = tabs.filter(tab => groupIdOf(tab) !== NO_GROUP).map(tab => tab.id);
		if (grouped.length)
		{
			items.push({ label: plural(grouped.length, 'Remove from Group', 'Remove # Tabs from Group'), action: () => browser.tabs.ungroup(grouped) });
		}
	}

	items.push(
		'-',
		{
			label: allPinned ? plural(n, 'Unpin Tab', 'Unpin # Tabs') : plural(n, 'Pin Tab', 'Pin # Tabs'),
			action: () => Promise.all(ids.map(id => browser.tabs.update(id, { pinned: !allPinned }))),
		},
		{
			label: allMuted ? plural(n, 'Unmute Tab', 'Unmute # Tabs') : plural(n, 'Mute Tab', 'Mute # Tabs'),
			action: () => setMuted(ids, !allMuted),
		},
		{ label: plural(n, 'Reload Tab', 'Reload # Tabs'), history: false, action: () => Promise.all(ids.map(id => browser.tabs.reload(id))) },
		{ label: plural(n, 'Duplicate Tab', 'Duplicate # Tabs'), action: () => Promise.all(ids.map(id => browser.tabs.duplicate(id))) },
		'-',
		{ label: plural(n, 'Copy Link', 'Copy # Links'), immediate: true, action: () => copyLinks(ids) },
		'-',
	);
	if (HAS_BOOKMARKS)
	{
		const submenu = storeSubmenu(ids);
		items.push({ label: plural(n, 'Store Tab as', 'Store # Tabs as'), disabled: !submenu.length, submenu });
	}
	items.push({ label: plural(n, 'Close Tab', 'Close # Tabs'), immediate: true, action: () => closeTabsWithUndo(ids) });
	return items;
}

function windowMenuItems(windowId)
{
	const win = getWindow(windowId);
	if (!win)
	{
		return [];
	}
	const others = state.windows.filter(other => other.id !== windowId);
	const selectedOthers = [...state.selectedWindows].filter(id => id !== windowId && getWindow(id));
	const unpinned = win.tabs.filter(tab => !tab.pinned);
	const windowDuplicates = duplicateIds(tabsInScope(windowId)).length;
	const groupCount = new Set(win.tabs.map(groupIdOf).filter(id => id !== NO_GROUP)).size;
	const allDuplicates = duplicateIds(tabsInScope(null)).length;
	const items = [];

	if (HAS_SESSIONS)
	{
		items.push({ label: 'Rename Window…', history: false, action: () => startRename(windowId) }, '-');
	}
	if (selectedOthers.length)
	{
		items.push({ label: plural(selectedOthers.length, 'Merge Selected Window Here', 'Merge # Selected Windows Here'), action: () => mergeWindows(selectedOthers, windowId) });
	}
	items.push(
		{ label: 'Merge Into', disabled: !others.length, submenu: others.map(other => ({ label: windowName(other), action: () => mergeWindows([windowId], other.id) })) },
		{ label: 'Merge All Windows Here', disabled: !others.length, action: () => mergeWindows(others.map(other => other.id), windowId) },
		'-',
		...(HAS_GROUPS ? [{
			label: `Move All Groups (${groupCount}) to`,
			disabled: !groupCount,
			submenu: [
				{ label: 'Start', action: () => moveAllGroups(windowId, 'start') },
				{ label: 'End', action: () => moveAllGroups(windowId, 'end') },
				{ label: 'New Window', action: () => moveAllGroups(windowId, 'new') },
			],
		}, '-'] : []),
		{ label: 'Sort Tabs by Title', disabled: unpinned.length < 2, action: () => sortWindow(windowId, 'title') },
		{ label: 'Sort Tabs by Domain', disabled: unpinned.length < 2, action: () => sortWindow(windowId, 'url') },
		'-',
		{
			label: 'Select All Tabs in Window',
			history: false,
			disabled: !win.tabs.length,
			action: () =>
			{
				// Expand the card too: only visible tabs stay selected. The render runs once this action ends.
				state.collapsedWindows.delete(windowId);
				if (!isExpanded(windowId))
				{
					state.expandedWindows.has(windowId) ? state.expandedWindows.delete(windowId) : state.expandedWindows.add(windowId);
				}
				win.tabs.forEach(tab => state.selection.add(tab.id));
				render();
				updateSelectionUi();
			},
		},
		'-',
		{ label: `Close Duplicate Tabs (${windowDuplicates})`, disabled: !windowDuplicates, action: () => closeDuplicates(windowId) },
		{ label: `Close Duplicate Tabs in All Windows (${allDuplicates})`, disabled: !allDuplicates, action: () => closeDuplicates(null) },
	);
	if (HAS_BOOKMARKS)
	{
		// Pinned tabs are left out when storing a whole window.
		const submenu = storeSubmenu(unpinned.map(tab => tab.id));
		items.push('-', { label: 'Store Tabs as', disabled: !submenu.length, submenu });
	}
	// The window with TabCentral itself cannot be closed from here: the page would close with it.
	items.push('-', {
		label: win.current ? 'Close Window (this is TabCentral’s window)' : 'Close Window',
		disabled: win.current,
		immediate: true,
		action: () => closeWindowWithUndo(windowId),
	});
	return items;
}

function storedMenuItems(setId)
{
	return [
		{ label: 'Restore in New Window', history: false, action: () => restoreStored(setId, 'new') },
		{ label: 'Restore in Current Window', history: false, action: () => restoreStored(setId, 'current') },
		'-',
		{ label: 'Delete Stored Tabs…', history: false, action: () => deleteStored(setId) },
	];
}

function pageMenuItems()
{
	return [
		{ label: 'Back Up All Windows and Tabs', history: false, action: exportBackup },
		{ label: 'Restore from Backup…', immediate: true, action: pickBackupFile },
		'-',
		{ label: 'Settings', immediate: true, action: () => openOptions('settings') },
		{ label: 'Keyboard Shortcuts', immediate: true, action: () => openOptions('shortcuts') },
		{ label: 'About TabCentral', immediate: true, action: () => openOptions('about') },
	];
}

// Opens the settings page at a section, reusing a tab that already shows it.
async function openOptions(section)
{
	const url = `${OPTIONS_URL}#${section}`;
	const [existing] = (await browser.tabs.query({})).filter(tab => (tab.url || '').startsWith(OPTIONS_URL));
	if (existing)
	{
		await browser.tabs.update(existing.id, { active: true, url });
		await browser.windows.update(existing.windowId, { focused: true });
		return;
	}
	const self = await browser.tabs.getCurrent();
	await browser.tabs.create({ url, index: self ? self.index + 1 : undefined });
}

function cardIdOf(card)
{
	return card.dataset.windowId ? Number(card.dataset.windowId) : card.dataset.storedId;
}

function cardMenuItems(card)
{
	return card.dataset.windowId ? windowMenuItems(Number(card.dataset.windowId)) : storedMenuItems(card.dataset.storedId);
}

function groupMenuItems(groupId)
{
	const group = state.groupsById.get(groupId);
	if (!group)
	{
		return [];
	}
	const others = windowSubmenu([group.windowId], windowId => browser.tabGroups.move(groupId, { windowId, index: -1 }));

	return [
		{ label: 'Edit Group…', action: () => editGroup(groupId) },
		{
			label: 'New Tab in Group',
			action: async () =>
			{
				const tab = await browser.tabs.create({ windowId: group.windowId, active: false });
				await browser.tabs.group({ groupId, tabIds: [tab.id] });
			},
		},
		{
			label: group.collapsed ? 'Expand Group in Tab Bar' : 'Collapse Group in Tab Bar',
			action: () => browser.tabGroups.update(groupId, { collapsed: !group.collapsed }),
		},
		{
			label: 'Move Group',
			submenu: [
				{ label: 'Move to Start', action: () => moveGroupToStart(groupId) },
				{ label: 'Move to End', action: () => browser.tabGroups.move(groupId, { windowId: group.windowId, index: -1 }) },
				{ label: 'Move to New Window', action: () => moveGroupToNewWindow(groupId) },
				...(others.length ? ['-', ...others] : []),
			],
		},
		'-',
		{ label: 'Ungroup Tabs', action: () => browser.tabs.ungroup(tabsInGroup(groupId).map(tab => tab.id)) },
		{ label: 'Delete Group', action: () => deleteGroup(groupId) },
	];
}

function menuPosition(e, node)
{
	// Keyboard-triggered context menus report 0,0; anchor those to the element.
	if (e.type === 'contextmenu' && (e.clientX || e.clientY))
	{
		return [e.clientX, e.clientY];
	}
	const rect = node.getBoundingClientRect();
	return [rect.left, rect.bottom + 2];
}

/* Dialogs */

function waitForClose(dialog)
{
	return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

async function groupDialog({ heading, okLabel, title, color })
{
	const dialog = $('#group-dialog');
	$('#group-dialog-heading').textContent = heading;
	$('#group-ok').textContent = okLabel;
	$('#group-name').value = title;
	dialog.querySelector(`input[name="group-color"][value="${GROUP_COLORS.includes(color) ? color : 'grey'}"]`).checked = true;
	dialog.returnValue = '';
	dialog.showModal();
	$('#group-name').select();

	if (!await waitForClose(dialog))
	{
		return null;
	}
	return {
		title: $('#group-name').value.trim(),
		color: dialog.querySelector('input[name="group-color"]:checked').value,
	};
}

async function confirmDialog(message, okLabel)
{
	const dialog = $('#confirm-dialog');
	$('#confirm-message').textContent = message;
	$('#confirm-ok').textContent = okLabel;
	dialog.returnValue = '';
	dialog.showModal();
	return waitForClose(dialog);
}

// Returns the trimmed text, or null when cancelled or left empty.
async function promptDialog({ heading, label, value, okLabel })
{
	const dialog = $('#prompt-dialog');
	$('#prompt-heading').textContent = heading;
	$('#prompt-label').textContent = label;
	$('#prompt-ok').textContent = okLabel;
	const input = $('#prompt-input');
	input.value = value || '';
	dialog.returnValue = '';
	dialog.showModal();
	input.select();
	return await waitForClose(dialog) ? input.value.trim() || null : null;
}

function buildColorPicker()
{
	const picker = $('#group-colors');
	for (const color of GROUP_COLORS)
	{
		picker.append(el('label', { class: 'color-option', title: color[0].toUpperCase() + color.slice(1) },
			el('input', { type: 'radio', name: 'group-color', value: color, 'aria-label': color, style: { '--group-color': groupColor(color) } }),
		));
	}
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

/* Drag and drop */

function eventElement(e)
{
	return e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
}

function resolveDropTarget(e)
{
	const drag = state.drag;
	const element = drag && eventElement(e);
	if (!element)
	{
		return null;
	}

	const zone = element.closest('#new-window-zone');
	if (zone)
	{
		return { kind: 'newWindow', el: zone, plan: null };
	}
	const card = element.closest('.card[data-window-id]');
	if (!card)
	{
		return null;
	}
	const windowId = Number(card.dataset.windowId);

	let target;
	if (state.sort === 'recent')
	{
		// In recency order positions have no meaning; dragged tabs can only go to the end of another window.
		const ids = draggedIds(drag);
		if (ids.length && ids.every(id => state.tabsById.get(id)?.windowId === windowId))
		{
			return null;
		}
		target = { kind: 'end', windowId, el: card };
	}
	else
	{
		const row = element.closest('.tab-row[data-tab-id]');
		const header = element.closest('.group-header[data-group-id]');
		if (row)
		{
			const rect = row.getBoundingClientRect();
			target = { kind: 'row', windowId, tabId: Number(row.dataset.tabId), before: e.clientY < rect.top + rect.height / 2, el: row };
		}
		else if (header)
		{
			target = { kind: 'groupStart', windowId, groupId: Number(header.dataset.groupId), el: header };
		}
		else
		{
			target = { kind: 'end', windowId, el: card };
		}
	}

	// Dropping where the tabs already are changes nothing, so it is not a drop target.
	target.plan = planDrop(drag, target);
	return target.plan && !isNoopDrop(drag, target.plan) ? target : null;
}

function draggedIds(drag)
{
	if (drag.type === 'group')
	{
		return tabsInGroup(drag.groupId).map(tab => tab.id);
	}
	return drag.type === 'tabs' ? drag.ids : [];
}

/**
 * Turns a drop target into: the window, the tab to insert before (null for
 * the end) and, for tabs, the group to join. A dragged group never lands
 * inside another group.
 */
function planDrop(drag, target)
{
	const dragged = new Set(draggedIds(drag));
	const windowId = target.windowId;
	let anchor = null;
	let groupId = NO_GROUP;

	if (target.kind === 'row')
	{
		const rowTab = state.tabsById.get(target.tabId);
		if (!rowTab)
		{
			return null;
		}
		anchor = findAnchor(windowId, rowTab.index + (target.before ? 0 : 1), dragged);
		groupId = rowTab.pinned ? NO_GROUP : groupIdOf(rowTab);
	}
	else if (target.kind === 'groupStart')
	{
		const first = tabsInGroup(target.groupId)[0];
		anchor = first ? findAnchor(windowId, first.index, dragged) : null;
	}

	if (drag.type === 'group')
	{
		groupId = NO_GROUP;
		const anchorGroup = anchor ? groupIdOf(anchor) : NO_GROUP;
		if (anchorGroup !== NO_GROUP)
		{
			const members = tabsInGroup(anchorGroup);
			if (members[0].id !== anchor.id)
			{
				anchor = findAnchor(windowId, members.at(-1).index + 1, dragged);
			}
		}
	}
	return { windowId, anchorId: anchor ? anchor.id : null, groupId };
}

// True when the dragged tabs already sit, in order, right before the anchor (and in the target group).
function isNoopDrop(drag, plan)
{
	if (drag.type === 'stored')
	{
		return false;
	}
	const ids = drag.type === 'group' ? draggedIds(drag) : orderIds(drag.ids);
	const tabs = getWindow(plan.windowId)?.tabs || [];
	const positions = ids.map(id => tabs.findIndex(tab => tab.id === id));
	if (!positions.length || positions.some((pos, i) => pos < 0 || (i > 0 && pos !== positions[i - 1] + 1)))
	{
		return false;
	}
	const next = tabs[positions.at(-1) + 1];
	if ((next ? next.id : null) !== plan.anchorId)
	{
		return false;
	}
	return drag.type === 'group' || ids.every(id => groupIdOf(state.tabsById.get(id)) === plan.groupId);
}

function showDropIndicator(target)
{
	let cls = null;
	if (target)
	{
		cls = target.kind === 'row' ? (target.before ? 'drop-before' : 'drop-after') : target.kind === 'groupStart' ? 'drop-before' : 'drop-target';
	}
	if (state.dropEl === (target?.el || null) && state.dropClass === cls)
	{
		return;
	}
	state.dropEl?.classList.remove(state.dropClass);
	state.dropEl = target?.el || null;
	state.dropClass = cls;
	state.dropEl?.classList.add(cls);
}

function endDrag()
{
	if (!state.drag)
	{
		return;
	}
	state.drag = null;
	showDropIndicator(null);
	document.body.classList.remove('dragging');
	for (const node of document.querySelectorAll('.drag-source'))
	{
		node.classList.remove('drag-source');
	}
	if (state.renderPending)
	{
		render();
	}
}

// First unpinned, non-dragged tab at or after fromIndex: the tab the dropped tabs go in front of.
function findAnchor(windowId, fromIndex, dragged)
{
	return getWindow(windowId)?.tabs.find(tab => !tab.pinned && tab.index >= fromIndex && !dragged.has(tab.id)) || null;
}

async function performDrop(drag, target)
{
	const plan = target.plan;
	if (drag.type === 'stored')
	{
		await restoreStoredAt(drag.bookmarkIds, plan);
		return;
	}
	if (drag.type === 'group')
	{
		if (!plan)
		{
			await moveGroupToNewWindow(drag.groupId);
		}
		else if (plan.anchorId == null)
		{
			await browser.tabGroups.move(drag.groupId, { windowId: plan.windowId, index: -1 });
		}
		else
		{
			await moveGroupBefore(drag.groupId, plan.anchorId);
		}
		return;
	}
	if (!plan)
	{
		await moveToNewWindow(drag.ids);
		return;
	}
	await moveTabs(drag.ids, plan.windowId, plan.anchorId);
	await setGroup(drag.ids, plan.groupId);
}

function onDragStart(e)
{
	const target = eventElement(e);
	const storedRow = target.closest('[data-bookmark-id]');
	const header = target.closest('.group-header[data-group-id]');
	const row = target.closest('.tab-row[data-tab-id]');
	closeMenus();

	if (storedRow)
	{
		state.drag = { type: 'stored', bookmarkIds: [storedRow.dataset.bookmarkId] };
		storedRow.classList.add('drag-source');
	}
	else if (header && HAS_GROUPS)
	{
		state.drag = { type: 'group', groupId: Number(header.dataset.groupId) };
		header.classList.add('drag-source');
		for (const id of draggedIds(state.drag))
		{
			document.querySelector(`#windows .tab-row[data-tab-id="${id}"]`)?.classList.add('drag-source');
		}
	}
	else if (row)
	{
		const tabId = Number(row.dataset.tabId);
		const ids = actionIds(tabId).filter(id => !state.tabsById.get(id)?.pinned);
		if (!ids.length)
		{
			e.preventDefault();
			return;
		}
		state.drag = { type: 'tabs', ids };
		for (const id of ids)
		{
			document.querySelector(`#windows .tab-row[data-tab-id="${id}"]`)?.classList.add('drag-source');
		}
		if (ids.length > 1)
		{
			const ghost = el('div', { class: 'drag-ghost', text: `${ids.length} tabs` });
			document.body.append(ghost);
			e.dataTransfer.setDragImage(ghost, 12, 12);
			setTimeout(() => ghost.remove());
		}
	}
	else
	{
		return;
	}

	e.dataTransfer.effectAllowed = 'move';
	e.dataTransfer.setData('application/x-tab-central', 'move');
	document.body.classList.add('dragging');
}

function onDragOver(e)
{
	if (!state.drag)
	{
		return;
	}
	const target = resolveDropTarget(e);
	showDropIndicator(target);
	if (target)
	{
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
	}
}

function onDrop(e)
{
	const drag = state.drag;
	const target = resolveDropTarget(e);
	e.preventDefault();
	endDrag();
	if (drag && target)
	{
		// Restoring stored tabs consumes bookmarks, which undo cannot bring back.
		run(() => performDrop(drag, target), drag.type === 'stored' ? null : 'Drag and Drop');
	}
}

/* Event handling */

/**
 * True while the clicked row, card or placeholder is sliding or fading: the
 * click was probably aimed at whatever was there a moment ago.
 */
function isMoving(target)
{
	const nodes = [target.closest('[data-tab-id], [data-placeholder], .group-header'), target.closest('.card')];
	return nodes.some(node => node && node.getAnimations().some(animation => LAYOUT_ANIMATION_IDS.has(animation.id) && animation.playState === 'running'));
}

function onClick(e)
{
	const target = eventElement(e);
	if (isMoving(target))
	{
		return;
	}

	const card = target.closest('.card');
	const cardId = card ? cardIdOf(card) : null;
	if (card && target.closest('.card-header'))
	{
		const more = target.closest('.card-more');
		if (more)
		{
			openMenu(cardMenuItems(card), ...menuPosition(e, more));
		}
		else if (card.dataset.windowId && !target.closest('.twisty'))
		{
			// Clicking a window title selects (or unselects) the window; the chevron collapses it.
			if (e.detail > 1)
			{
				return;
			}
			rememberSelection();
			if (e.ctrlKey || e.metaKey || e.shiftKey || state.selectedWindows.has(cardId))
			{
				toggleWindowSelected(cardId);
			}
			else
			{
				state.selectedWindows = new Set([cardId]);
				updateSelectionUi();
			}
		}
		else
		{
			state.collapsedWindows.has(cardId) ? state.collapsedWindows.delete(cardId) : state.collapsedWindows.add(cardId);
			render();
		}
		return;
	}
	if (card && target.closest('.show-more'))
	{
		state.expandedWindows.has(cardId) ? state.expandedWindows.delete(cardId) : state.expandedWindows.add(cardId);
		render();
		return;
	}

	const storedRow = target.closest('[data-bookmark-id]');
	if (storedRow)
	{
		if (target.closest('.close'))
		{
			run(() => removeStoredTab(storedRow.dataset.bookmarkId));
		}
		return;
	}

	const header = target.closest('.group-header[data-group-id]');
	if (header)
	{
		const groupId = Number(header.dataset.groupId);
		const more = target.closest('.more');
		if (more)
		{
			openMenu(groupMenuItems(groupId), ...menuPosition(e, more));
		}
		else
		{
			state.collapsedGroups.has(groupId) ? state.collapsedGroups.delete(groupId) : state.collapsedGroups.add(groupId);
			render();
		}
		return;
	}

	const tabEl = target.closest('[data-tab-id]');
	if (!tabEl)
	{
		return;
	}
	const tabId = Number(tabEl.dataset.tabId);
	const tab = state.tabsById.get(tabId);

	if (target.closest('.close'))
	{
		closeTabsWithUndo([tabId]);
	}
	else if (target.closest('.more'))
	{
		openMenu(tabMenuItems(actionIds(tabId)), ...menuPosition(e, target.closest('.more')));
	}
	else if (target.closest('.audio'))
	{
		run(() => setMuted([tabId], !tab?.mutedInfo?.muted), tab?.mutedInfo?.muted ? 'Unmute Tab' : 'Mute Tab');
	}
	else if (e.detail > 1)
	{
		// Second click of a double-click: leave the selection to the dblclick handler.
	}
	else
	{
		rememberSelection();
		if (e.ctrlKey || e.metaKey)
		{
			if (e.shiftKey)
			{
				selectRange(tabId, true);
			}
			else
			{
				toggleSelected(tabId);
			}
		}
		else if (e.shiftKey)
		{
			selectRange(tabId, false);
		}
		else if (state.selection.has(tabId))
		{
			toggleSelected(tabId);
		}
		else
		{
			selectOnly(tabId);
		}
	}
}

/**
 * The first click of a double-click already changed the selection. Remember
 * the selection before each click so a double-click can put it back.
 */
let selectionBeforeClick = null;

function rememberSelection()
{
	selectionBeforeClick = {
		tabs: new Set(state.selection),
		windows: new Set(state.selectedWindows),
		anchor: state.selectionAnchor,
	};
}

function restoreSelectionBeforeClick()
{
	if (selectionBeforeClick)
	{
		state.selection = selectionBeforeClick.tabs;
		state.selectedWindows = selectionBeforeClick.windows;
		state.selectionAnchor = selectionBeforeClick.anchor;
		selectionBeforeClick = null;
		updateSelectionUi();
	}
}

// Double-click opens a tab or stored tab, or renames a window, without changing the selection.
function onDoubleClick(e)
{
	const target = eventElement(e);
	if (target.closest('button:not(.pinned-tab), input') || isMoving(target))
	{
		return;
	}
	const title = target.closest('.card[data-window-id] .card-header h2');
	const tabEl = target.closest('[data-tab-id]');
	const storedRow = target.closest('[data-bookmark-id]');
	const card = target.closest('.card');
	if (title)
	{
		restoreSelectionBeforeClick();
		startRename(Number(title.closest('.card').dataset.windowId));
	}
	else if (tabEl)
	{
		restoreSelectionBeforeClick();
		openTab(Number(tabEl.dataset.tabId), e.ctrlKey || e.metaKey);
	}
	else if (storedRow)
	{
		run(() => openStoredTab(storedRow.dataset.bookmarkId));
	}
	else if (card && card.querySelector('.show-more') && !target.closest('.group-header'))
	{
		// Anywhere else on a card: Show more / Show less.
		restoreSelectionBeforeClick();
		toggleExpanded(cardIdOf(card));
		render();
	}
}

// Switches to a tab; with `here`, first brings it next to TabCentral.
function openTab(tabId, here)
{
	if (here)
	{
		run(() => openTabHere(tabId), 'Open Tab in This Window');
	}
	else
	{
		run(() => activateTab(tabId));
	}
}

function onAuxClick(e)
{
	// Middle-click closes a tab, as in the tab strip.
	const tabEl = e.button === 1 && !isMoving(eventElement(e)) && eventElement(e).closest('[data-tab-id]');
	if (tabEl)
	{
		e.preventDefault();
		if (tabEl.matches('.tab-row'))
		{
			closeTabsWithUndo([Number(tabEl.dataset.tabId)]);
		}
		else
		{
			run(() => removeTabs([Number(tabEl.dataset.tabId)]), 'Close Tab', { quiet: true });
		}
	}
}

function onContextMenu(e)
{
	const target = eventElement(e);
	const cardHeader = target.closest('.card-header');
	const header = target.closest('.group-header[data-group-id]');
	const tabEl = target.closest('[data-tab-id]');
	if (cardHeader)
	{
		e.preventDefault();
		openMenu(cardMenuItems(cardHeader.closest('.card')), ...menuPosition(e, cardHeader));
	}
	else if (header)
	{
		e.preventDefault();
		openMenu(groupMenuItems(Number(header.dataset.groupId)), ...menuPosition(e, header));
	}
	else if (tabEl)
	{
		e.preventDefault();
		openMenu(tabMenuItems(actionIds(Number(tabEl.dataset.tabId))), ...menuPosition(e, tabEl));
	}
}

function isTyping()
{
	const active = document.activeElement;
	return !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
}

function onKeyDown(e)
{
	if (document.querySelector('dialog[open]'))
	{
		return;
	}

	if (openMenus.length && handleMenuKey(e))
	{
		return;
	}

	if (e.key === 'Escape')
	{
		hideUndoTip();
		if (openMenus.length)
		{
			closeMenus();
			menuReturnFocus?.focus({ preventScroll: true });
		}
		else if (document.activeElement === $('#search') && $('#search').value)
		{
			clearSearch();
		}
		else
		{
			clearSelection();
		}
		return;
	}

	// Ctrl+F, Ctrl+K, Ctrl+P and Ctrl+/ (and / outside a text field) go to the search box instead of the browser.
	const searchKey = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && ['f', 'k', 'p', '/'].includes(e.key.toLowerCase());
	if (searchKey || (e.key === '/' && !isTyping() && !e.ctrlKey && !e.metaKey && !e.altKey))
	{
		e.preventDefault();
		closeMenus();
		$('#search').focus();
		$('#search').select();
		return;
	}

	// Arrow down from the search box goes to the first listed tab.
	if (e.key === 'ArrowDown' && document.activeElement === $('#search'))
	{
		e.preventDefault();
		focusRow(navigableRows()[0]);
		return;
	}

	if (openMenus.length || isTyping())
	{
		return;
	}

	const focusedRow = document.activeElement?.closest?.('#windows [data-tab-id]');
	if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && focusedRow)
	{
		// Alt+Up/Down: move the focused tab (or the selection it belongs to) one place, the keyboard counterpart of dragging.
		e.preventDefault();
		const tabId = Number(focusedRow.dataset.tabId);
		const ids = actionIds(tabId);
		const up = e.key === 'ArrowUp';
		if (!state.busy)
		{
			run(() => moveTabsStep(ids, up ? -1 : 1), plural(ids.length, up ? 'Move Tab Up' : 'Move Tab Down', up ? 'Move # Tabs Up' : 'Move # Tabs Down'), { quiet: true });
		}
		return;
	}

	const focusedHeader = document.activeElement?.closest?.('#windows .group-header[data-group-id]');
	if (focusedHeader && e.target === focusedHeader && (e.key === 'Enter' || e.key === ' '))
	{
		e.preventDefault();
		const groupId = Number(focusedHeader.dataset.groupId);
		state.collapsedGroups.has(groupId) ? state.collapsedGroups.delete(groupId) : state.collapsedGroups.add(groupId);
		render();
		announce(state.collapsedGroups.has(groupId) ? 'Group collapsed' : 'Group expanded');
		return;
	}

	if (handleNavigationKey(e))
	{
		return;
	}

	// Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes. Ignored while another action is still running.
	const key = e.key.toLowerCase();
	if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y'))
	{
		e.preventDefault();
		if (!state.busy)
		{
			(key === 'y' || e.shiftKey ? redo : undo)().catch(showError);
		}
		return;
	}

	const tabEl = document.activeElement?.closest?.('#windows [data-tab-id]');
	if (e.key === 'Delete' && (state.selection.size || tabEl))
	{
		// Focus (and, for a selection, the selection) moves on to the nearest tab that stays.
		const hadSelection = state.selection.size > 0;
		const ids = hadSelection ? orderIds(state.selection) : [Number(tabEl.dataset.tabId)];
		const next = neighbourRow(ids);
		closeTabsWithUndo(ids);
		focusRow(next);
		if (hadSelection && next?.dataset.tabId)
		{
			selectOnly(Number(next.dataset.tabId));
		}
	}
	else if (e.key === 'a' && (e.ctrlKey || e.metaKey))
	{
		e.preventDefault();
		state.selection = new Set(visibleTabIds());
		updateSelectionUi();
	}
	else if (tabEl && e.target === tabEl && e.key === 'Enter')
	{
		openTab(Number(tabEl.dataset.tabId), e.ctrlKey || e.metaKey);
	}
	else if (e.key === 'Enter' && e.target.dataset?.bookmarkId)
	{
		run(() => openStoredTab(e.target.dataset.bookmarkId));
	}
	else if (tabEl && e.target === tabEl && e.key === ' ')
	{
		e.preventDefault();
		toggleSelected(Number(tabEl.dataset.tabId));
	}
}

/* Keyboard navigation */

const ROW_SELECTOR = '[data-tab-id], .group-header[data-group-id], [data-bookmark-id]';

// Rows that arrow keys move through, in screen order: tabs (pinned included), group headers and stored tabs.
function navigableRows()
{
	return [...document.querySelectorAll(`#windows :is(${ROW_SELECTOR}), #stored:not([hidden]) [data-bookmark-id]`)];
}

/**
 * Roving Tab stop: of all rows only one is in the Tab order (the last focused
 * one, else the first), so Tab moves past the whole list in one step and the
 * arrow keys move within it.
 */
function updateRovingStop()
{
	const rows = navigableRows();
	const stop = rows.find(row => layoutKey(row) === state.rovingKey) || rows[0];
	for (const row of document.querySelectorAll('[tabindex="0"]:is([data-tab-id], .group-header, [data-bookmark-id])'))
	{
		row.tabIndex = -1;
	}
	if (stop)
	{
		stop.tabIndex = 0;
	}
}

function onRowFocus(e)
{
	const row = eventElement(e).closest?.(ROW_SELECTOR);
	if (row && !row.classList.contains('ghost') && !row.closest('.ghost'))
	{
		state.rovingKey = layoutKey(row);
		updateRovingStop();
	}
}

/**
 * Moves tabs one place up or down within their window (tab order view only).
 * A spread-out selection is gathered next to the neighbour it passes.
 */
async function moveTabsStep(ids, direction)
{
	const tabs = tabsOf(ids);
	const win = tabs.length ? getWindow(tabs[0].windowId) : null;
	if (!win || state.sort !== 'order' || tabs.some(tab => tab.pinned || tab.windowId !== win.id))
	{
		announce('Only unpinned tabs of one window can be moved, in the tab order view');
		return;
	}
	const moving = new Set(ids);
	const rows = win.tabs.filter(tab => !tab.pinned);
	const positions = rows.map((tab, i) => moving.has(tab.id) ? i : -1).filter(i => i >= 0);
	const ordered = orderIds(ids);
	if (direction < 0)
	{
		const neighbour = rows.slice(0, positions[0]).reverse().find(tab => !moving.has(tab.id));
		if (neighbour)
		{
			await moveTabs(ordered, win.id, neighbour.id);
		}
		return;
	}
	const neighbour = rows.slice(positions.at(-1) + 1).find(tab => !moving.has(tab.id));
	if (neighbour)
	{
		const after = rows.slice(rows.indexOf(neighbour) + 1).find(tab => !moving.has(tab.id));
		await moveTabs(ordered, win.id, after ? after.id : null);
	}
}

// The first row below the given tabs that is not one of them, else the last one above.
function neighbourRow(ids)
{
	const closing = new Set(ids);
	const rows = navigableRows();
	const positions = rows.map((row, i) => closing.has(Number(row.dataset.tabId)) ? i : -1).filter(i => i >= 0);
	if (!positions.length)
	{
		return null;
	}
	const stays = row => !closing.has(Number(row.dataset.tabId));
	return rows.slice(positions.at(-1) + 1).find(stays) || rows.slice(0, positions[0]).reverse().find(stays) || null;
}

function focusRow(row)
{
	if (row)
	{
		row.focus({ preventScroll: true });
		row.scrollIntoView({ block: 'nearest' });
	}
}

/**
 * Up/Down: previous/next row. Left/Right: same position in the previous/next
 * card. Home/End: first/last row. With Shift, the selection extends to the
 * new row. Returns true when the key was handled.
 */
function handleNavigationKey(e)
{
	if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey)
	{
		return false;
	}
	const rows = navigableRows();
	if (!rows.length)
	{
		return false;
	}
	const current = document.activeElement?.closest?.(ROW_SELECTOR);
	const index = rows.indexOf(current);
	let target;

	if (e.key === 'Home' || e.key === 'End')
	{
		target = e.key === 'Home' ? rows[0] : rows.at(-1);
	}
	else if (index < 0)
	{
		target = rows[0];
	}
	else if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
	{
		target = rows[index + (e.key === 'ArrowDown' ? 1 : -1)];
	}
	else
	{
		const cards = [...document.querySelectorAll('#windows .card, #stored:not([hidden]) .card')].filter(card => card.querySelector(ROW_SELECTOR));
		const card = current.closest('.card');
		const cardRows = [...card.querySelectorAll(ROW_SELECTOR)];
		const nextCard = cards[cards.indexOf(card) + (e.key === 'ArrowRight' ? 1 : -1)];
		if (nextCard)
		{
			const nextRows = [...nextCard.querySelectorAll(ROW_SELECTOR)];
			target = nextRows[Math.min(cardRows.indexOf(current), nextRows.length - 1)];
		}
	}

	e.preventDefault();
	if (!target)
	{
		return true;
	}
	focusRow(target);
	if (e.shiftKey && target.dataset.tabId)
	{
		if (current?.dataset.tabId && state.selectionAnchor == null)
		{
			state.selectionAnchor = Number(current.dataset.tabId);
		}
		selectRange(Number(target.dataset.tabId), false);
	}
	return true;
}

let menuReturnFocus = null;

/**
 * Keys inside an open menu: Up/Down/Home/End move between items, Right or
 * Enter on a submenu item opens it, Left closes the submenu. Enter and Space
 * on an item click it (native button behaviour). Returns true when handled.
 */
function handleMenuKey(e)
{
	const menu = openMenus.at(-1);
	const items = [...menu.querySelectorAll('.menu-item:not([disabled])')];
	const index = items.indexOf(document.activeElement);
	const active = items[index];

	if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')
	{
		e.preventDefault();
		const next = e.key === 'Home' ? 0
			: e.key === 'End' ? items.length - 1
			: e.key === 'ArrowDown' ? (index + 1) % items.length
			: (index - 1 + items.length) % items.length;
		items[index < 0 && e.key === 'ArrowUp' ? items.length - 1 : next]?.focus();
		return true;
	}
	if ((e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') && active?.classList.contains('has-submenu'))
	{
		e.preventDefault();
		active.click();
		openMenus.at(-1).querySelector('.menu-item:not([disabled])')?.focus();
		return true;
	}
	if (e.key === 'ArrowLeft' && openMenus.length > 1)
	{
		e.preventDefault();
		const parentItem = openMenus.at(-2).querySelector('.menu-item.open');
		closeMenus(openMenus.length - 1);
		parentItem?.classList.remove('open');
		parentItem?.focus();
		return true;
	}
	return e.key !== 'Escape';
}

function bindEvents()
{
	const windows = $('#windows');
	windows.addEventListener('auxclick', onAuxClick);
	windows.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
	for (const container of [windows, $('#stored')])
	{
		container.addEventListener('focusin', onRowFocus);
		container.addEventListener('click', onClick);
		container.addEventListener('dblclick', onDoubleClick);
		container.addEventListener('contextmenu', onContextMenu);
		container.addEventListener('dragstart', onDragStart);
	}

	// Clicking empty page space clears the selection.
	$('main').addEventListener('click', e =>
	{
		if (!eventElement(e).closest('.card, .toolbar, .drop-zone'))
		{
			clearSelection();
		}
	});
	document.addEventListener('dragover', onDragOver);
	document.addEventListener('drop', onDrop);
	document.addEventListener('dragend', endDrag);
	document.addEventListener('keydown', onKeyDown);

	document.addEventListener('mousedown', e =>
	{
		if (openMenus.length && !eventElement(e).closest('.menu'))
		{
			closeMenus();
		}
	}, true);
	window.addEventListener('blur', () => closeMenus());
	window.addEventListener('resize', () => closeMenus());
	document.addEventListener('scroll', () => closeMenus(), true);

	$('#search').addEventListener('input', e => setQuery(e.target.value));
	$('#search-clear').append(iconNode('close'));
	$('#search-clear').addEventListener('click', () =>
	{
		clearSearch();
		$('#search').focus();
	});

	for (const radio of document.querySelectorAll('input[name="sort"]'))
	{
		radio.checked = radio.value === state.sort;
		radio.addEventListener('change', () =>
		{
			state.sort = radio.value;
			writePref(SORT_KEY, state.sort);
			render();
		});
	}

	$('#selection-clear').addEventListener('click', clearSelection);

	$('#stored-toggle').append(iconNode('chevron'));
	$('#stored-title').addEventListener('click', () =>
	{
		// During a search the section opens to show matches; collapsing it then lasts until the search is cleared.
		const searching = !!searchFilter(state.renderedQuery);
		if (searching)
		{
			state.storedClosedInSearch = !state.storedClosedInSearch;
		}
		else
		{
			state.storedOpen = !state.storedOpen;
			writePref(STORED_OPEN_KEY, state.storedOpen ? '1' : '0');
		}
		// Applied to the page at once: the render may be on hold while an action finishes.
		applyStoredOpen(isStoredOpen(searching));
		render();
	});

	$('#page-menu').append(iconNode('more'));
	$('#page-menu').addEventListener('click', e => openMenu(pageMenuItems(), ...menuPosition(e, e.currentTarget)));
	$('#backup-file').addEventListener('change', e =>
	{
		const file = e.target.files[0];
		if (file)
		{
			run(() => importBackup(file));
		}
	});

	$('#toggle-expand').addEventListener('click', () =>
	{
		state.expandAll = !state.expandAll;
		state.expandedWindows.clear();
		writePref(EXPAND_KEY, state.expandAll ? '1' : '0');
		render();
	});

	$('#card-size').addEventListener('click', () =>
	{
		state.cardSize = CARD_SIZES[(CARD_SIZES.indexOf(state.cardSize) + 1) % CARD_SIZES.length];
		writePref(CARD_SIZE_KEY, state.cardSize);
		updateViewControls();
	});

	document.addEventListener('visibilitychange', () =>
	{
		if (!document.hidden && state.stale)
		{
			state.stale = false;
			scheduleRefresh();
		}
	});

	for (const name of ['onCreated', 'onRemoved', 'onMoved', 'onAttached', 'onDetached', 'onUpdated', 'onActivated', 'onReplaced'])
	{
		browser.tabs[name]?.addListener(scheduleRefresh);
	}
	browser.windows.onCreated.addListener(scheduleRefresh);
	browser.windows.onRemoved.addListener(scheduleRefresh);
	if (HAS_GROUPS)
	{
		for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved'])
		{
			browser.tabGroups[name]?.addListener(scheduleRefresh);
		}
	}
	if (HAS_BOOKMARKS)
	{
		for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved'])
		{
			browser.bookmarks[name]?.addListener(scheduleRefresh);
		}
	}
}

function updateViewControls()
{
	document.body.dataset.cardSize = state.cardSize;
	const sizeButton = $('#card-size');
	sizeButton.replaceChildren(iconNode(CARD_SIZE_ICONS[state.cardSize]));
	sizeButton.title = CARD_SIZE_LABELS[state.cardSize];
	sizeButton.setAttribute('aria-label', `Card layout: ${CARD_SIZE_LABELS[state.cardSize]}`);
	const toggle = $('#toggle-expand');
	toggle.replaceChildren(iconNode(state.expandAll ? 'collapseAll' : 'expandAll'));
	toggle.title = state.expandAll ? 'Show fewer tabs per card' : 'Show all tabs per card';
	toggle.setAttribute('aria-label', toggle.title);
	toggle.setAttribute('aria-pressed', String(state.expandAll));
}

// localStorage only holds view preferences; it may be unavailable, in which case defaults apply.
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
		// Storage unavailable or full; the preference just won't persist.
	}
}

async function init()
{
	// "Last used choice" by default; the settings page can fix it to one sort.
	const defaultSort = readPref(DEFAULT_SORT_KEY, 'last');
	state.sort = (defaultSort === 'last' ? readPref(SORT_KEY, 'order') : defaultSort) === 'recent' ? 'recent' : 'order';
	state.expandAll = readPref(EXPAND_KEY, '0') === '1';
	state.storedOpen = readPref(STORED_OPEN_KEY, '0') === '1';
	const size = readPref(CARD_SIZE_KEY, 'normal');
	state.cardSize = CARD_SIZES.includes(size) ? size : 'normal';
	try
	{
		const favicons = JSON.parse(readPref(FAVICON_KEY, '{}'));
		state.favicons = favicons && typeof favicons === 'object' ? favicons : {};
	}
	catch (err)
	{
		state.favicons = {};
	}
	updateViewControls();
	loadLocalViewState();
	loadPublicSuffixList().catch(console.error);
	buildColorPicker();
	bindEvents();
	try
	{
		await load();
		render();
	}
	catch (err)
	{
		showError(err);
	}
}

init();
