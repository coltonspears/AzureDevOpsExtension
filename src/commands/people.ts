import * as vscode from 'vscode';
import { PersonResult } from '../api/core';
import { scopeLabel } from '../auth/scopes';
import { Services } from '../services';
import { log } from '../util/logger';

interface PersonItem extends vscode.QuickPickItem {
  person?: PersonResult;
  freeText?: string;
  me?: boolean;
  clear?: boolean;
}

/**
 * Searches people as the user types. Without the Identity scope it still works by letting
 * the user type an email address, and says why search results are missing.
 */
export function searchPeopleQuickPick(
  services: Services,
  options: { title: string; includeMe?: boolean; includeClear?: boolean; allowFreeText?: boolean; allowGroups?: boolean },
): Promise<PersonItem | undefined> {
  const connection = services.connections.require();
  const searchDenied = services.access.isDenied('vso.identity');
  return new Promise(resolve => {
    const pick = vscode.window.createQuickPick<PersonItem>();
    pick.title = options.title;
    pick.placeholder = searchDenied
      ? `Type an email address (searching needs the "${scopeLabel('vso.identity')}" scope)`
      : 'Type a name or email to search';
    pick.matchOnDescription = true;
    const fixed: PersonItem[] = [];
    if (options.includeMe) {
      fixed.push({ label: `$(account) Me (${connection.user.displayName})`, me: true, alwaysShow: true });
    }
    if (options.includeClear) {
      fixed.push({ label: '$(circle-slash) Unassigned', clear: true, alwaysShow: true });
    }
    pick.items = fixed;
    let timer: NodeJS.Timeout | undefined;
    let generation = 0;
    pick.onDidChangeValue(value => {
      clearTimeout(timer);
      const text = value.trim();
      const freeText: PersonItem[] =
        options.allowFreeText && text.includes('@') ? [{ label: `$(mail) Use "${text}"`, freeText: text, alwaysShow: true }] : [];
      // Once the user types, "Me"/"Unassigned" must not stay pinned on top, or pressing Enter
      // before search results arrive would pick them instead of what was typed.
      const shortcuts = fixed.map(item => ({ ...item, alwaysShow: !text }));
      pick.items = [...freeText, ...shortcuts];
      if (searchDenied || text.length < 2) {
        return;
      }
      const current = ++generation;
      timer = setTimeout(async () => {
        pick.busy = true;
        try {
          const people = await connection.api.core.searchPeople(text);
          if (current !== generation) {
            return;
          }
          pick.items = [
            ...people
              .filter(p => options.allowGroups || !p.isGroup)
              .map(p => ({
                label: `${p.isGroup ? '$(organization)' : '$(person)'} ${p.displayName}`,
                description: p.mail,
                person: p,
                alwaysShow: true,
              })),
            ...freeText,
            ...shortcuts,
          ];
        } catch (error) {
          log.warn(`People search failed: ${String(error)}`);
          pick.items = [...freeText, ...shortcuts];
          if (services.access.isDenied('vso.identity')) {
            pick.placeholder = `Type an email address (searching needs the "${scopeLabel('vso.identity')}" scope)`;
          }
        } finally {
          if (current === generation) {
            pick.busy = false;
          }
        }
      }, 300);
    });
    let accepted: PersonItem | undefined;
    pick.onDidAccept(() => {
      accepted = pick.selectedItems[0];
      pick.hide();
    });
    pick.onDidHide(() => {
      clearTimeout(timer);
      pick.dispose();
      resolve(accepted);
    });
    pick.show();
  });
}

/** Picks a person for an identity field; returns "Name <email>", '' for unassigned. */
export async function pickPerson(services: Services, title: string): Promise<string | undefined> {
  const item = await searchPeopleQuickPick(services, { title, includeMe: true, includeClear: true, allowFreeText: true });
  if (!item) {
    return undefined;
  }
  if (item.clear) {
    return '';
  }
  if (item.me) {
    const user = services.connections.require().user;
    return user.email ? `${user.displayName} <${user.email}>` : user.displayName;
  }
  if (item.freeText) {
    return item.freeText;
  }
  const person = item.person!;
  return person.mail ? `${person.displayName} <${person.mail}>` : person.displayName;
}

/** Picks a reviewer (user or group) and returns its identity id. */
export async function pickReviewer(services: Services, title: string): Promise<PersonResult | undefined> {
  if (services.access.isDenied('vso.identity')) {
    await services.access.explainMissing('vso.identity', 'search for reviewers');
    return undefined;
  }
  const item = await searchPeopleQuickPick(services, { title, allowGroups: true });
  return item?.person;
}
