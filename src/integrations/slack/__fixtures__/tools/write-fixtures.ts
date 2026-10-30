import {
  CHANNEL_ONE,
  CHANNEL_TWO,
  DM_ONE,
  USER_ME,
  USER_PARTNER,
  USER_THIRD,
  tsFor,
} from './ids.js';
import {
  conversationsInfoRoute,
  createFakeSlack,
  directChannel,
  privateChannel,
  publicChannel,
  rawMessage,
  rawUser,
  repliesRoute,
  usersInfoRoute,
} from './fake-slack.js';

export const ROOM_NAME = 'example-room';
export const PRIVATE_ROOM_NAME = 'example-private-room';
export const ME_NAME = 'Example Me';
export const PARTNER_NAME = 'Example Partner';
export const THIRD_NAME = 'Example Third';

/** The ts of the message the thread-link tests treat as the thread root. */
export const ROOT_TS = tsFor(0);

export const HIGH_POST_OFFSET = 2000;

/** A fake client with the read routes the prepare step relies on. */
export function createWriteFakeSlack() {
  return createFakeSlack({
    routes: {
      'conversations.info': conversationsInfoRoute({
        [CHANNEL_ONE]: publicChannel(CHANNEL_ONE, ROOM_NAME),
        [CHANNEL_TWO]: privateChannel(CHANNEL_TWO, PRIVATE_ROOM_NAME),
        [DM_ONE]: directChannel(DM_ONE, USER_PARTNER),
      }),
      'users.info': usersInfoRoute([
        rawUser({ id: USER_ME, displayName: ME_NAME }),
        rawUser({ id: USER_PARTNER, displayName: PARTNER_NAME }),
        rawUser({ id: USER_THIRD, displayName: THIRD_NAME }),
      ]),
      'conversations.replies': repliesRoute({
        [`${CHANNEL_ONE}:${ROOT_TS}`]: [rawMessage({ ts: ROOT_TS, user: USER_PARTNER })],
      }),
      'conversations.members': (params) => ({
        members: params.channel === DM_ONE ? [USER_ME, USER_PARTNER] : [USER_ME, USER_PARTNER, USER_THIRD],
      }),
    },
  });
}

export interface PostItemOptions {
  destination?: string;
  expectedDestination?: string | null;
  text?: string;
  ref?: string;
}

/** A post item aimed at CHANNEL_ONE by id, carrying the matching expected destination. */
export function postItem(options: PostItemOptions = {}) {
  const item: Record<string, unknown> = {
    action: 'post',
    destination: options.destination ?? CHANNEL_ONE,
    text: options.text ?? 'reply text',
  };
  if (options.expectedDestination !== null) {
    item.expected_destination = options.expectedDestination ?? ROOM_NAME;
  }
  if (options.ref) item.ref = options.ref;
  return item;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function settleMicrotasksAndTimers(milliseconds: number = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
