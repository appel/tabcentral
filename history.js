'use strict';

/**
 * Undo/redo for tab operations started from the TabCentral page.
 *
 * Every recorded action stores a layout snapshot from before and after it,
 * plus the set of tabs and windows the action changed. Undo/redo restores
 * only those tabs and windows, so changes made elsewhere are left alone.
 *
 * Limits:
 * - Closed tabs are recreated (unloaded) from their URL, so their
 *   back/forward history is lost. Pages an extension may not open
 *   (about:, file:, ...) cannot be recreated.
 * - Restoring or deleting stored tabs is not recorded, because undoing it
 *   could lose bookmarks.
 * - Tab, window and group ids change when they are recreated; aliases map
 *   the old ids to the new ones so older history entries stay usable.
 */

const HISTORY_LIMIT = 30;
const UNDO_CONFIRM_THRESHOLD = 20;

const undoHistory = {
	undo: [],
	redo: [],
	tabAlias: new Map(),
	windowAlias: new Map(),
	groupAlias: new Map(),
};

function resolveAlias(map, id)
{
	const seen = new Set();
	while (map.has(id) && !seen.has(id))
	{
		seen.add(id);
		id = map.get(id);
	}
	return id;
}

const resolveTab = id => resolveAlias(undoHistory.tabAlias, id);
const resolveWindow = id => resolveAlias(undoHistory.windowAlias, id);
const resolveGroup = id => resolveAlias(undoHistory.groupAlias, id);

// Snapshot of everything undo needs: tab positions and state, groups and window names.
async function captureLayout()
{
	const [tabs, windows, groups] = await Promise.all([
		browser.tabs.query({ windowType: 'normal' }),
		browser.windows.getAll({ windowTypes: ['normal'] }),
		HAS_GROUPS ? browser.tabGroups.query({}) : [],
	]);
	const names = HAS_SESSIONS
		? await Promise.all(windows.map(win => browser.sessions.getWindowValue(win.id, WINDOW_NAME_KEY).catch(() => null)))
		: [];

	const layout = { tabs: new Map(), groups: new Map(), names: new Map() };
	for (const tab of tabs)
	{
		if (tab.url && tab.url.startsWith(OWN_PREFIX))
		{
			continue;
		}
		layout.tabs.set(tab.id, {
			windowId: tab.windowId,
			index: tab.index,
			pinned: tab.pinned,
			muted: !!tab.mutedInfo?.muted,
			groupId: groupIdOf(tab),
			url: tab.url,
			title: tab.title,
		});
	}
	for (const group of groups)
	{
		layout.groups.set(group.id, { title: group.title || '', color: group.color, collapsed: !!group.collapsed });
	}
	windows.forEach((win, i) => layout.names.set(win.id, typeof names[i] === 'string' ? names[i] : ''));
	return layout;
}

function windowOrder(layout, windowId)
{
	return [...layout.tabs].filter(([, tab]) => tab.windowId === windowId).sort((a, b) => a[1].index - b[1].index).map(([id]) => id);
}

// Tabs and window names that differ between two layouts.
function diffLayouts(before, after)
{
	const tabIds = new Set();
	const signature = tab => `${tab.windowId}|${tab.pinned}|${tab.muted}|${tab.groupId}`;

	for (const [id, tab] of before.tabs)
	{
		const other = after.tabs.get(id);
		if (!other || signature(other) !== signature(tab))
		{
			tabIds.add(id);
		}
	}
	for (const id of after.tabs.keys())
	{
		if (!before.tabs.has(id))
		{
			tabIds.add(id);
		}
	}

	// A changed relative order marks every tab of that window.
	const windowIds = new Set([...before.tabs.values(), ...after.tabs.values()].map(tab => tab.windowId));
	for (const windowId of windowIds)
	{
		const common = id => before.tabs.has(id) && after.tabs.has(id) && before.tabs.get(id).windowId === windowId && after.tabs.get(id).windowId === windowId;
		const orderBefore = windowOrder(before, windowId).filter(common);
		const orderAfter = windowOrder(after, windowId).filter(common);
		if (orderBefore.join() !== orderAfter.join())
		{
			orderBefore.forEach(id => tabIds.add(id));
		}
	}

	// Changed group properties mark the tabs of that group.
	const groupKey = group => group && `${group.title}|${group.color}|${group.collapsed}`;
	for (const groupId of new Set([...before.groups.keys(), ...after.groups.keys()]))
	{
		if (groupKey(before.groups.get(groupId)) !== groupKey(after.groups.get(groupId)))
		{
			for (const layout of [before, after])
			{
				for (const [id, tab] of layout.tabs)
				{
					if (tab.groupId === groupId)
					{
						tabIds.add(id);
					}
				}
			}
		}
	}

	const names = new Set();
	for (const windowId of new Set([...before.names.keys(), ...after.names.keys()]))
	{
		if (before.names.has(windowId) && after.names.has(windowId) && before.names.get(windowId) !== after.names.get(windowId))
		{
			names.add(windowId);
		}
	}
	return { tabIds, names };
}

async function recordHistory(label, before, result)
{
	const after = await captureLayout();
	const affected = diffLayouts(before, after);
	if (!affected.tabIds.size && !affected.names.size)
	{
		return;
	}
	const entry = { label, before, after, affected };
	if (result && result.storedFolderId)
	{
		entry.store = result;
	}
	if (result && result.session)
	{
		entry.session = result.session;
	}
	undoHistory.undo.push(entry);
	if (undoHistory.undo.length > HISTORY_LIMIT)
	{
		undoHistory.undo.shift();
	}
	undoHistory.redo = [];
	return entry;
}

/**
 * The entry Firefox added to its recently closed list for a tab or window we
 * just closed, so undo can restore it with its back/forward history.
 */
async function closedSession(kind, windowId = null)
{
	if (!HAS_SESSIONS)
	{
		return null;
	}
	const [recent] = await browser.sessions.getRecentlyClosed({ maxResults: 1 }).catch(() => []);
	const item = recent && recent[kind];
	return item && item.sessionId ? { session: { kind, sessionId: item.sessionId, windowId } } : null;
}

/**
 * Restores a closed tab or window from Firefox's recently closed list and maps
 * the old ids to the new ones. Returns false when the session entry is gone
 * (Firefox only keeps a limited number), so the caller can fall back.
 */
async function restoreSession(entry)
{
	try
	{
		const restored = await browser.sessions.restore(entry.session.sessionId);
		const closedIds = [...entry.affected.tabIds].filter(id => entry.before.tabs.has(id) && !entry.after.tabs.has(id));
		if (entry.session.kind === 'tab' && restored.tab && closedIds.length === 1)
		{
			undoHistory.tabAlias.set(resolveTab(closedIds[0]), restored.tab.id);
		}
		if (entry.session.kind === 'window' && restored.window)
		{
			undoHistory.windowAlias.set(resolveWindow(entry.session.windowId), restored.window.id);
			const oldIds = windowOrder(entry.before, entry.session.windowId);
			const newTabs = (restored.window.tabs || []).filter(tab => !(tab.url || '').startsWith(OWN_PREFIX)).sort((a, b) => a.index - b.index);
			oldIds.forEach((id, i) => newTabs[i] && undoHistory.tabAlias.set(resolveTab(id), newTabs[i].id));
		}
		// Restoring selects the restored tab or window; come back to TabCentral.
		await bringSelfToFront();
		return true;
	}
	catch (err)
	{
		console.error(err);
		return false;
	}
	finally
	{
		// A session entry can only be restored once.
		entry.session = null;
	}
}

async function performUndo(entry)
{
	if (!entry.session || !await restoreSession(entry))
	{
		await applyLayout(entry.before, entry.affected);
	}
	if (entry.store)
	{
		await browser.bookmarks.removeTree(entry.store.storedFolderId).catch(console.error);
	}
	onEntryUndone(entry);
}

// Undoes one specific entry, e.g. from a "Tab closed. Undo" placeholder, even if it is not the latest.
async function undoEntry(entry)
{
	const index = undoHistory.undo.indexOf(entry);
	if (index < 0)
	{
		showToast('Already undone');
		return;
	}
	const latest = index === undoHistory.undo.length - 1;
	undoHistory.undo.splice(index, 1);
	await run(async () =>
	{
		await performUndo(entry);
		if (latest)
		{
			undoHistory.redo.push(entry);
		}
	}, null, { quiet: true, fresh: false });
}

/**
 * Brings the affected tabs and windows back to `target`:
 * 1. Recreate missing windows and tabs.
 * 2. Ungroup everything in the affected windows, set pinned/muted, move tabs
 *    to their windows and reorder each window left to right.
 * 3. Recreate the groups, close tabs that do not exist in `target`, restore
 *    window names and remove helper tabs of recreated windows.
 */
async function applyLayout(target, affected)
{
	const now = await captureLayout();
	const wanted = [...affected.tabIds].filter(id => target.tabs.has(id));
	const unwanted = [...affected.tabIds].filter(id => !target.tabs.has(id)).map(resolveTab).filter(id => now.tabs.has(id));
	const existingWindows = new Set((await browser.windows.getAll({ windowTypes: ['normal'] })).map(win => win.id));
	const helperTabs = [];
	let failed = 0;

	// 1. Windows and tabs that no longer exist.
	for (const windowId of new Set(wanted.map(id => target.tabs.get(id).windowId)))
	{
		if (!existingWindows.has(resolveWindow(windowId)))
		{
			const win = await browser.windows.create({});
			undoHistory.windowAlias.set(resolveWindow(windowId), win.id);
			existingWindows.add(win.id);
			helperTabs.push(...(win.tabs || []).map(tab => tab.id));
		}
	}
	for (const id of wanted)
	{
		if (now.tabs.has(resolveTab(id)))
		{
			continue;
		}
		const tab = target.tabs.get(id);
		try
		{
			const created = await browser.tabs.create({ windowId: resolveWindow(tab.windowId), url: tab.url, title: tab.title, discarded: true, active: false });
			undoHistory.tabAlias.set(resolveTab(id), created.id);
		}
		catch (err)
		{
			console.error(tab.url, err);
			failed++;
		}
	}

	const live = new Map((await browser.tabs.query({ windowType: 'normal' })).map(tab => [tab.id, tab]));
	const windows = new Set(wanted.map(id => resolveWindow(target.tabs.get(id).windowId)));
	for (const id of affected.tabIds)
	{
		const tab = live.get(resolveTab(id));
		if (tab)
		{
			windows.add(tab.windowId);
		}
	}

	// 2. Remember and dissolve the groups in the affected windows, so moves cannot break them.
	const previousGroup = new Map();
	if (HAS_GROUPS)
	{
		const grouped = [...live.values()].filter(tab => windows.has(tab.windowId) && groupIdOf(tab) !== NO_GROUP);
		for (const tab of grouped)
		{
			previousGroup.set(tab.id, tab.groupId);
		}
		if (grouped.length)
		{
			await browser.tabs.ungroup(grouped.map(tab => tab.id));
		}
	}

	for (const id of wanted)
	{
		const want = target.tabs.get(id);
		const tab = live.get(resolveTab(id));
		if (!tab)
		{
			continue;
		}
		if (tab.pinned !== want.pinned || !!tab.mutedInfo?.muted !== want.muted)
		{
			await browser.tabs.update(tab.id, { pinned: want.pinned, muted: want.muted });
		}
		const windowId = resolveWindow(want.windowId);
		if (tab.windowId !== windowId)
		{
			if (want.pinned)
			{
				await movePinnedTab(tab.id, windowId);
			}
			else
			{
				await browser.tabs.move(tab.id, { windowId, index: -1 });
			}
		}
	}

	// Snapshot id of each live tab, to look up its wanted group.
	const snapshotId = new Map([...target.tabs.keys()].map(id => [resolveTab(id), id]));
	for (const windowId of windows)
	{
		await reorderWindow(windowId, target, snapshotId);
	}

	// 3. Groups: wanted membership for snapshot tabs, previous membership for others.
	if (HAS_GROUPS)
	{
		const fresh = (await browser.tabs.query({ windowType: 'normal' })).filter(tab => windows.has(tab.windowId) && !tab.pinned).sort((a, b) => a.index - b.index);
		const groups = new Map();
		for (const tab of fresh)
		{
			const id = snapshotId.get(tab.id);
			const fromTarget = id != null && target.tabs.has(id) && !unwanted.includes(tab.id);
			let key;
			let props;
			if (fromTarget)
			{
				const snapshotGroup = target.tabs.get(id).groupId;
				key = snapshotGroup === NO_GROUP ? NO_GROUP : resolveGroup(snapshotGroup);
				props = target.groups.get(snapshotGroup);
			}
			else
			{
				key = previousGroup.get(tab.id) ?? NO_GROUP;
				props = now.groups.get(key);
			}
			if (key === NO_GROUP)
			{
				continue;
			}
			// Keys are current group ids, so snapshot tabs and newer tabs of the same group end up together.
			if (!groups.has(key))
			{
				groups.set(key, { windowId: tab.windowId, tabIds: [], props });
			}
			const group = groups.get(key);
			group.tabIds.push(tab.id);
			if (fromTarget && props)
			{
				group.props = props;
			}
		}
		for (const [key, group] of groups)
		{
			const groupId = await browser.tabs.group({ tabIds: group.tabIds, createProperties: { windowId: group.windowId } });
			if (group.props)
			{
				await browser.tabGroups.update(groupId, group.props);
			}
			undoHistory.groupAlias.set(resolveGroup(key), groupId);
		}
	}

	if (unwanted.length)
	{
		await removeTabs(unwanted);
	}

	if (HAS_SESSIONS)
	{
		for (const windowId of affected.names)
		{
			const resolved = resolveWindow(windowId);
			if (existingWindows.has(resolved))
			{
				await setWindowName(resolved, target.names.get(windowId) || '');
			}
		}
	}

	if (helperTabs.length)
	{
		await browser.tabs.remove(helperTabs);
		await refocusSelf();
	}
	if (failed)
	{
		showToast(`${plural(failed, '1 tab', '# tabs')} could not be reopened by the extension`, true);
	}
}

/**
 * Puts the snapshot tabs of a window in their snapshot order. Tabs unknown to
 * the snapshot keep roughly their current position. Pinned tabs stay first.
 */
async function reorderWindow(windowId, target, snapshotId)
{
	const current = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
	const known = current
		.filter(tab => snapshotId.has(tab.id) && target.tabs.get(snapshotId.get(tab.id))?.windowId != null && resolveWindow(target.tabs.get(snapshotId.get(tab.id)).windowId) === windowId)
		.sort((a, b) => target.tabs.get(snapshotId.get(a.id)).index - target.tabs.get(snapshotId.get(b.id)).index);
	const knownIds = new Set(known.map(tab => tab.id));

	const desired = known.slice();
	for (const tab of current)
	{
		if (!knownIds.has(tab.id))
		{
			desired.splice(Math.min(tab.index, desired.length), 0, tab);
		}
	}
	desired.sort((a, b) => b.pinned - a.pinned);

	// Left to right, every tab only moves left, which keeps target indexes unambiguous.
	const order = current.map(tab => tab.id);
	for (let i = 0; i < desired.length; i++)
	{
		const at = order.indexOf(desired[i].id);
		if (at === i || at < 0)
		{
			continue;
		}
		await browser.tabs.move(desired[i].id, { index: i });
		order.splice(at, 1);
		order.splice(i, 0, desired[i].id);
	}
}

async function confirmLargeChange(verb, entry)
{
	const count = entry.affected.tabIds.size;
	return count <= UNDO_CONFIRM_THRESHOLD
		|| confirmDialog(`${verb} “${entry.label}”? This changes ${plural(count, '1 tab', '# tabs')}.`, verb);
}

async function undo()
{
	const entry = undoHistory.undo.at(-1);
	if (!entry)
	{
		showToast('Nothing to undo');
		return;
	}
	if (!await confirmLargeChange('Undo', entry))
	{
		return;
	}
	undoHistory.undo.pop();
	await run(async () =>
	{
		await performUndo(entry);
		undoHistory.redo.push(entry);
		showToast(`Undone: ${entry.label}`);
	}, null, { fresh: false });
}

async function redo()
{
	const entry = undoHistory.redo.at(-1);
	if (!entry)
	{
		showToast('Nothing to redo');
		return;
	}
	if (!await confirmLargeChange('Redo', entry))
	{
		return;
	}
	undoHistory.redo.pop();
	await run(async () =>
	{
		if (entry.store)
		{
			// Storing again creates a new bookmark folder; the stored ids may have been recreated.
			const ids = entry.store.storedIds.map(resolveTab);
			Object.assign(entry.store, await storeTabs(ids, entry.store.title));
		}
		else
		{
			await applyLayout(entry.after, entry.affected);
		}
		undoHistory.undo.push(entry);
		showToast(`Redone: ${entry.label}`);
	});
}
