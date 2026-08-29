// src/combobox.ts
//
// Search box for adding clocks. Replaces the native <datalist>, which on iOS
// renders as a suggestion strip above the keyboard that is easy to miss — people
// typed "Vancouver", pressed Add, and got an "invalid timezone" alert with no
// hint that they were meant to pick from a list.
//
// Here the list is always visible while typing, the first result is selected by
// default, and Enter or a tap commits it. There is no way to submit something
// that isn't a real zone, so there is nothing to reject.

import { loadCityIndex, searchPlaces, zoneFromRawInput, type PlaceResult } from './cities';

export interface ComboboxOptions {
  input: HTMLInputElement;
  listbox: HTMLElement;
  /** Every zone on the map, so zone ids stay searchable without the city index. */
  zoneIds: () => string[];
  onSelect: (result: PlaceResult) => void;
}

export function createSearchCombobox({ input, listbox, zoneIds, onSelect }: ComboboxOptions) {
  let results: PlaceResult[] = [];
  let active = -1;
  let queryToken = 0;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listbox.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.autocomplete = 'off';
  listbox.setAttribute('role', 'listbox');

  function close() {
    results = [];
    active = -1;
    listbox.innerHTML = '';
    listbox.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function render() {
    listbox.innerHTML = '';
    if (results.length === 0) {
      listbox.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
      return;
    }

    results.forEach((result, i) => {
      const option = document.createElement('li');
      option.id = `${listbox.id}-opt-${i}`;
      option.className = 'combobox-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === active));
      if (i === active) option.classList.add('is-active');

      const primary = document.createElement('span');
      primary.className = 'combobox-primary';
      primary.textContent = result.primary;

      const secondary = document.createElement('span');
      secondary.className = 'combobox-secondary';
      secondary.textContent = result.secondary;

      option.append(primary, secondary);
      // mousedown, not click: pointer-down fires before the input's blur, so the
      // list is still open when the selection is read.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        commit(i);
      });
      option.addEventListener('mouseenter', () => setActive(i));
      listbox.appendChild(option);
    });

    listbox.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listbox.id}-opt-${active}`);
  }

  function setActive(next: number) {
    if (next === active) return;
    active = next;
    [...listbox.children].forEach((child, i) => {
      child.classList.toggle('is-active', i === active);
      child.setAttribute('aria-selected', String(i === active));
    });
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${listbox.id}-opt-${active}`);
      listbox.children[active]?.scrollIntoView({ block: 'nearest' });
    }
  }

  function commit(i: number) {
    const chosen = results[i];
    if (!chosen) return;
    onSelect(chosen);
    input.value = '';
    close();
  }

  async function search(query: string) {
    const token = ++queryToken;
    if (!query.trim()) return close();

    // Render zone matches immediately, then again once the city index is in.
    // Typing stays responsive on the very first search, which is the one that
    // has to wait for the download.
    const show = (index: Awaited<ReturnType<typeof loadCityIndex>>) => {
      if (token !== queryToken) return; // a newer keystroke already won
      results = searchPlaces(query, zoneIds(), index);
      const raw = zoneFromRawInput(query);
      if (raw && !results.some((r) => r.tzid === raw.tzid)) results.unshift(raw);
      active = results.length > 0 ? 0 : -1;
      render();
    };

    show(null);
    show(await loadCityIndex());
  }

  input.addEventListener('input', () => void search(input.value));
  input.addEventListener('focus', () => {
    // Warm the index on focus so the first keystroke usually has it already.
    void loadCityIndex();
    if (input.value.trim()) void search(input.value);
  });
  input.addEventListener('blur', () => window.setTimeout(close, 120));

  input.addEventListener('keydown', (event) => {
    if (results.length === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((active + 1) % results.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((active - 1 + results.length) % results.length);
        break;
      case 'Enter':
        event.preventDefault();
        commit(active >= 0 ? active : 0);
        break;
      case 'Escape':
        close();
        break;
    }
  });

  return { close, commitFirst: () => commit(active >= 0 ? active : 0) };
}
