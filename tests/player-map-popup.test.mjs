import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPlayerMapPopup } from '../views/playerMapPopup.ts';

class FakeTextNode {
  constructor(value) {
    this.nodeType = 3;
    this.textContent = value;
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  get textContent() {
    return this.children.map(child => child.textContent).join('');
  }
}

const fakeDocument = {
  createElement: tagName => new FakeElement(tagName),
  createTextNode: value => new FakeTextNode(value),
};

function collectTags(node) {
  return node.nodeType === 1
    ? [node.tagName, ...node.children.flatMap(collectTags)]
    : [];
}

function player(overrides = {}) {
  return { name: 'さくら', team: 'A', status: 'EMERGENCY', ...overrides };
}

describe('Leaflet player popup text rendering', () => {
  test('renders HTML-like player names as text nodes, not markup', () => {
    const name = '<img src=x onerror=alert(1)>さくら';
    const popup = createPlayerMapPopup(fakeDocument, player({ name }), 'TEAM_SEARCH');

    assert.match(popup.textContent, /<img src=x onerror=alert\(1\)>さくら/);
    assert.equal(collectTags(popup).includes('IMG'), false);
    assert.deepEqual(
      popup.children[0].children.map(child => child.nodeType),
      [3, 3],
    );
  });

  test('does not interpret script-like player names', () => {
    const name = '</b><script>alert(document.domain)</script>';
    const popup = createPlayerMapPopup(fakeDocument, player({ name }), 'EMERGENCY');

    assert.equal(popup.textContent, `【緊急:EMERGENCY】${name}`);
    assert.equal(collectTags(popup).includes('SCRIPT'), false);
    assert.deepEqual(
      popup.children[0].children.map(child => child.nodeType),
      [3, 3],
    );
  });

  test('preserves Japanese names and expected popup fields', () => {
    const popup = createPlayerMapPopup(
      fakeDocument,
      player({ name: '山田 太郎' }),
      'EXPOSED',
      '4:32',
    );

    assert.equal(popup.textContent, '山田 太郎 (Team A)📍 公開中の位置 (残り 4:32)');
    assert.deepEqual(collectTags(popup), ['DIV', 'B', 'BR', 'SMALL']);
  });

  test('retains the fixed emergency and reveal labels', () => {
    const emergency = createPlayerMapPopup(fakeDocument, player(), 'EMERGENCY');
    const search = createPlayerMapPopup(fakeDocument, player(), 'TEAM_SEARCH');
    const reveal = createPlayerMapPopup(fakeDocument, player(), 'GLOBAL_REVEAL');

    assert.equal(emergency.textContent, '【緊急:EMERGENCY】さくら');
    assert.equal(emergency.children[0].style.color, 'red');
    assert.match(search.textContent, /🚨 チーム個別サーチ中 \(リアルタイム\)/);
    assert.match(reveal.textContent, /📸 全員スナップショット公開中/);
  });
});
