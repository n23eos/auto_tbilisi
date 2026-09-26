import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function pagesIn(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? pagesIn(path) : entry.name.endsWith('.html') ? [path] : [];
  });
}

test('страницы и их JS-зависимости используют согласованные версии ресурсов', () => {
  const versions = new Map();
  const modules = new Set();

  function check(reference, owner) {
    const ownerUrl = new URL(relative(root, owner), 'https://site.test/');
    const url = new URL(reference, ownerUrl);
    if (url.origin !== ownerUrl.origin || !/\.(css|js)$/.test(url.pathname)) return;
    const label = `${relative(root, owner)}: ${reference}`;
    const version = url.searchParams.get('v');
    assert.match(version || '', /^\d+$/, `Нет версии: ${label}`);
    if (versions.has(url.pathname)) {
      assert.equal(version, versions.get(url.pathname), `Разные версии: ${label}`);
    }
    versions.set(url.pathname, version);
    const path = resolve(root, url.pathname.slice(1));
    const source = readFileSync(path, 'utf8');
    if (path.endsWith('.js') && !modules.has(path)) {
      modules.add(path);
      for (const match of source.matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        check(match[1], path);
      }
    }
  }

  const pages = [resolve(root, 'index.html'), resolve(root, '404.html'),
    ...pagesIn(resolve(root, 'bilety')), ...pagesIn(resolve(root, 'voprosy'))];
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
      check(match[1], page);
    }
  }
  assert.ok(modules.size > 0, 'Проверка должна обходить реальные ES modules');
});

test('общая шапка отличает вопросы о школе от вопросов ПДД', () => {
  const pages = [resolve(root, 'index.html'), resolve(root, '404.html'),
    ...pagesIn(resolve(root, 'bilety')), ...pagesIn(resolve(root, 'voprosy'))];
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const navigation = html.match(/<nav\b[^>]*aria-label="Разделы сайта"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(navigation, `Нет общей навигации: ${relative(root, page)}`);
    assert.match(navigation, /href="\/voprosy\/"[^>]*>Частые вопросы<\/a>/, relative(root, page));
    assert.match(navigation, /href="\/bilety\/"[^>]*>Билеты ПДД<\/a>/, relative(root, page));
  }
});
