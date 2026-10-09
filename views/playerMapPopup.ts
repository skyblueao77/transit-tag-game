import type { User } from '../types';

export type PlayerMapPopupVariant =
  | 'SELF'
  | 'EMERGENCY'
  | 'TEAM_SEARCH'
  | 'GLOBAL_REVEAL'
  | 'EXPOSED';

type PopupPlayer = Pick<User, 'name' | 'team' | 'status'>;

function appendText(document: Document, parent: Node, value: unknown): void {
  parent.appendChild(document.createTextNode(typeof value === 'string' ? value : ''));
}

function appendPlayerTitle(
  document: Document,
  title: HTMLElement,
  user: PopupPlayer,
): void {
  appendText(document, title, user.name);
  appendText(document, title, ` (Team ${typeof user.team === 'string' ? user.team : ''})`);
}

export function createPlayerMapPopup(
  document: Document,
  user: PopupPlayer,
  variant: PlayerMapPopupVariant,
  remainingTime?: string,
): HTMLElement {
  const popup = document.createElement('div');
  const title = document.createElement('b');

  if (variant === 'SELF') {
    appendText(document, title, '【自分】');
    appendPlayerTitle(document, title, user);
    popup.appendChild(title);
    popup.appendChild(document.createElement('br'));
    appendText(document, popup, '現在地');
    return popup;
  }

  if (variant === 'EMERGENCY') {
    title.style.color = 'red';
    appendText(document, title, `【緊急:${typeof user.status === 'string' ? user.status : ''}】`);
    appendText(document, title, user.name);
    popup.appendChild(title);
    return popup;
  }

  appendPlayerTitle(document, title, user);
  popup.appendChild(title);
  popup.appendChild(document.createElement('br'));

  const detail = document.createElement(variant === 'EXPOSED' ? 'small' : 'span');
  if (variant === 'TEAM_SEARCH') {
    detail.style.color = 'red';
    detail.style.fontWeight = 'bold';
    appendText(document, detail, '🚨 チーム個別サーチ中 (位置スナップショット公開)');
  } else if (variant === 'GLOBAL_REVEAL') {
    detail.style.color = 'orange';
    detail.style.fontWeight = 'bold';
    appendText(document, detail, '📸 全員スナップショット公開中');
  } else {
    appendText(document, detail, `📍 公開中の位置 (残り ${remainingTime ?? ''})`);
  }
  popup.appendChild(detail);

  return popup;
}
