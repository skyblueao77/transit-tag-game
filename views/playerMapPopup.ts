import type { User } from '../types';

export type PlayerMapPopupVariant =
  | 'SELF'
  | 'EMERGENCY'
  | 'TEAM_SEARCH'
  | 'GLOBAL_REVEAL'
  | 'PENALTY'
  | 'EXPOSED';

type PopupPlayer = Pick<User, 'name' | 'team' | 'status'> & {
  lastStation?: string;
  protectionZone?: User['protectionZone'];
};

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
    appendText(document, popup, user.lastStation ? `最寄: ${user.lastStation}` : '現在地');
    return popup;
  }

  if (variant === 'EMERGENCY') {
    title.style.color = 'red';
    appendText(document, title, `【緊急:${typeof user.status === 'string' ? user.status : ''}】`);
    appendText(document, title, user.name);
    popup.appendChild(title);
    if (user.lastStation) {
      popup.appendChild(document.createElement('br'));
      const st = document.createElement('small');
      appendText(document, st, `最寄: ${user.lastStation}`);
      popup.appendChild(st);
    }
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
  } else if (variant === 'PENALTY') {
    detail.style.color = '#dc2626';
    detail.style.fontWeight = 'bold';
    appendText(document, detail, `⚠️ ペナルティ位置強制公開中 (残り ${remainingTime ?? ''})`);
  } else {
    appendText(document, detail, `📍 公開中の位置 (残り ${remainingTime ?? ''})`);
  }
  popup.appendChild(detail);

  if (user.protectionZone && user.protectionZone !== 'NONE') {
    popup.appendChild(document.createElement('br'));
    const prot = document.createElement('small');
    prot.style.color = '#059669';
    prot.style.fontWeight = 'bold';
    const label = user.protectionZone === 'GREEN_CAR' ? 'グリーン席保護中' : 'セーフゾーン中';
    appendText(document, prot, `🛡️ ${label}`);
    popup.appendChild(prot);
  }

  if (user.lastStation) {
    popup.appendChild(document.createElement('br'));
    const st = document.createElement('small');
    st.style.color = '#2563eb';
    st.style.fontWeight = 'bold';
    appendText(document, st, `🚉 ${user.lastStation}`);
    popup.appendChild(st);
  }

  return popup;
}
