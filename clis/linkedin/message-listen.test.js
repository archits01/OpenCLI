import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import './message-listen.js';

const {
  parseLinkedInRealtimeFrame,
  parseNetworkCaptureEntry,
  parseDuration,
  extractThreadId,
  extractSenderUrn,
  extractBody,
  extractTimestamp,
  extractMessageId,
  reconstructThreadIdFromMessageUrn,
  findMessageObjects,
  parseLinkedInOwnMessages,
  extractProfileId,
} = await import('./message-listen.js').then((m) => m.__test__);

describe('linkedin message-listen adapter registration', () => {
  const command = getRegistry().get('linkedin/message-listen');

  it('registers with expected site, name, strategy, access', () => {
    expect(command).toBeDefined();
    expect(command.site).toBe('linkedin');
    expect(command.name).toBe('message-listen');
    expect(command.strategy).toBe('cookie');
    expect(command.access).toBe('read');
    expect(command.browser).toBe(true);
  });

  it('exposes expected columns', () => {
    expect(command.columns).toEqual([
      'event_type', 'thread_id', 'sender_urn', 'body', 'message_urn', 'timestamp', 'raw',
    ]);
  });

  it('defines expected args', () => {
    const argNames = command.args.map((a) => a.name);
    expect(argNames).toContain('duration');
    expect(argNames).toContain('thread');
    expect(argNames).toContain('type');
    expect(argNames).toContain('stream');
  });

  it('defines --stream as a bool arg defaulting to false', () => {
    const streamArg = command.args.find((a) => a.name === 'stream');
    expect(streamArg).toBeDefined();
    expect(streamArg.type).toBe('bool');
    expect(streamArg.default).toBe(false);
  });
});

describe('linkedin message-send adapter registration', () => {
  const command = getRegistry().get('linkedin/message-send');

  it('registers with expected site, name, strategy, access', () => {
    expect(command).toBeDefined();
    expect(command.site).toBe('linkedin');
    expect(command.name).toBe('message-send');
    expect(command.strategy).toBe('cookie');
    expect(command.access).toBe('write');
    expect(command.browser).toBe(true);
  });

  it('exposes expected columns', () => {
    expect(command.columns).toEqual(['ok', 'status', 'messageUrn', 'error']);
  });

  it('defines required args', () => {
    const argNames = command.args.map((a) => a.name);
    expect(argNames).toContain('thread-id');
    expect(argNames).toContain('message');
  });
});

describe('parseDuration', () => {
  it('returns default for undefined/null/empty', () => {
    expect(parseDuration(undefined)).toBe(60);
    expect(parseDuration(null)).toBe(60);
    expect(parseDuration('')).toBe(60);
  });

  it('accepts valid durations', () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(10)).toBe(10);
    expect(parseDuration(300)).toBe(300);
    expect(parseDuration(600)).toBe(600);
    expect(parseDuration(86400)).toBe(86400);
  });

  it('rejects out-of-range durations', () => {
    expect(() => parseDuration(86401)).toThrow(ArgumentError);
    expect(() => parseDuration(-1)).toThrow(ArgumentError);
  });

  it('rejects non-integer durations', () => {
    expect(() => parseDuration(10.5)).toThrow(ArgumentError);
  });
});

describe('parseLinkedInRealtimeFrame', () => {
  it('returns null for null/undefined input', () => {
    expect(parseLinkedInRealtimeFrame(null)).toBeNull();
    expect(parseLinkedInRealtimeFrame(undefined)).toBeNull();
  });

  it('returns null for non-string data', () => {
    expect(parseLinkedInRealtimeFrame({ data: 12345 })).toBeNull();
    expect(parseLinkedInRealtimeFrame({ data: null })).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseLinkedInRealtimeFrame({ data: 'not json', ts: 1000 })).toBeNull();
  });

  it('returns null for JSON with no recognized structure', () => {
    expect(parseLinkedInRealtimeFrame({ data: '{"foo":"bar"}', ts: 1000 })).toBeNull();
  });

  it('parses a message event', () => {
    const frame = {
      data: JSON.stringify({
        $type: 'com.linkedin.messenger.Message',
        conversationUrn: 'urn:li:messagingThread:2-abc123==',
        actorUrn: 'urn:li:member:12345',
        body: { text: 'Hello there!' },
        backendUrn: 'urn:li:message:(2-abc123==,67890)',
        createdAt: 1700000000000,
      }),
      ts: 1700000000500,
    };
    const result = parseLinkedInRealtimeFrame(frame);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('message');
    expect(result[0].thread_id).toBe('2-abc123==');
    expect(result[0].sender_urn).toBe('urn:li:member:12345');
    expect(result[0].body).toBe('Hello there!');
    expect(result[0].message_urn).toBe('urn:li:message:(2-abc123==,67890)');
    expect(result[0].timestamp).toBe(new Date(1700000000000).toISOString());
  });

  it('parses a typing indicator', () => {
    const frame = {
      data: JSON.stringify({
        $type: 'com.linkedin.messenger.TypingIndicator',
        conversationUrn: 'urn:li:messagingThread:2-typing==',
        actorUrn: 'urn:li:member:555',
        createdAt: 1700000002000,
      }),
      ts: 1700000002500,
    };
    const result = parseLinkedInRealtimeFrame(frame);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('typing');
    expect(result[0].body).toBe('');
  });

  it('parses a seen receipt', () => {
    const frame = {
      data: JSON.stringify({
        $type: 'com.linkedin.messenger.MessageSeenReceipt',
        conversationUrn: 'urn:li:messagingThread:2-seen==',
        actorUrn: 'urn:li:member:777',
        lastSeenMessageUrn: 'urn:li:message:(2-seen==,11111)',
        createdAt: 1700000003000,
      }),
      ts: 1700000003500,
    };
    const result = parseLinkedInRealtimeFrame(frame);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('seen');
    expect(result[0].message_urn).toBe('urn:li:message:(2-seen==,11111)');
  });

  it('parses a presence status', () => {
    const frame = {
      data: JSON.stringify({
        $type: 'com.linkedin.realtimeConnect.PresenceStatus',
        entityUrn: 'urn:li:member:333',
        status: 'ONLINE',
        createdAt: 1700000004000,
      }),
      ts: 1700000004500,
    };
    const result = parseLinkedInRealtimeFrame(frame);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('presence');
    expect(result[0].sender_urn).toBe('urn:li:member:333');
    expect(result[0].body).toBe('ONLINE');
  });

  it('parses events from included array', () => {
    const frame = {
      data: JSON.stringify({
        included: [
          {
            $type: 'com.linkedin.messenger.Message',
            conversationUrn: 'urn:li:messagingThread:2-inc1==',
            actorUrn: 'urn:li:member:111',
            body: { text: 'First' },
            createdAt: 1700000007000,
          },
          {
            $type: 'com.linkedin.messenger.Message',
            conversationUrn: 'urn:li:messagingThread:2-inc2==',
            actorUrn: 'urn:li:member:222',
            body: { text: 'Second' },
            createdAt: 1700000008000,
          },
        ],
      }),
      ts: 1700000008500,
    };
    const result = parseLinkedInRealtimeFrame(frame);
    expect(result).toHaveLength(2);
    expect(result[0].body).toBe('First');
    expect(result[1].body).toBe('Second');
  });
});

describe('parseNetworkCaptureEntry', () => {
  it('returns null for non-matching URLs', () => {
    expect(parseNetworkCaptureEntry({
      url: 'https://www.linkedin.com/voyager/api/identity',
      responsePreview: '{}',
    })).toBeNull();
  });

  it('returns null for missing responsePreview', () => {
    expect(parseNetworkCaptureEntry({
      url: 'https://www.linkedin.com/realtime/something',
    })).toBeNull();
  });

  it('returns null for base64-encoded responses', () => {
    expect(parseNetworkCaptureEntry({
      url: 'https://www.linkedin.com/realtime/something',
      responsePreview: 'base64:abc123',
    })).toBeNull();
  });

  it('parses message from realtime endpoint response', () => {
    const result = parseNetworkCaptureEntry({
      url: 'https://www.linkedin.com/realtime/realtimeFrontendSubscriptions',
      responsePreview: JSON.stringify({
        included: [{
          $type: 'com.linkedin.messenger.Message',
          conversationUrn: 'urn:li:messagingThread:2-net==',
          actorUrn: 'urn:li:member:999',
          body: { text: 'Network captured!' },
          createdAt: 1700000010000,
        }],
      }),
      timestamp: 1700000010500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('message');
    expect(result[0].body).toBe('Network captured!');
  });

  it('parses message from messaging GraphQL endpoint', () => {
    const result = parseNetworkCaptureEntry({
      url: 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages',
      responsePreview: JSON.stringify({
        included: [{
          $type: 'com.linkedin.messenger.Message',
          conversationUrn: 'urn:li:messagingThread:2-gql==',
          actorUrn: 'urn:li:member:888',
          body: { text: 'GraphQL message' },
          createdAt: 1700000011000,
        }],
      }),
      timestamp: 1700000011500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('GraphQL message');
  });
});

describe('extractThreadId', () => {
  it('extracts from conversationUrn', () => {
    expect(extractThreadId({ conversationUrn: 'urn:li:messagingThread:2-abc==' })).toBe('2-abc==');
  });

  it('extracts from backendConversationUrn', () => {
    expect(extractThreadId({ backendConversationUrn: 'urn:li:messagingThread:2-back==' })).toBe('2-back==');
  });

  it('falls back to threadUrn', () => {
    expect(extractThreadId({ threadUrn: 'urn:li:messagingThread:2-thread==' })).toBe('2-thread==');
  });

  it('returns raw string when no messagingThread pattern', () => {
    expect(extractThreadId({ conversationUrn: 'some:other:urn' })).toBe('some:other:urn');
  });

  it('returns empty string when no thread info', () => {
    expect(extractThreadId({})).toBe('');
  });
});

describe('extractSenderUrn', () => {
  it('prefers actorUrn', () => {
    expect(extractSenderUrn({ actorUrn: 'urn:li:member:1', senderUrn: 'urn:li:member:2' })).toBe('urn:li:member:1');
  });

  it('falls back to senderUrn', () => {
    expect(extractSenderUrn({ senderUrn: 'urn:li:member:2' })).toBe('urn:li:member:2');
  });

  it('returns empty string when nothing found', () => {
    expect(extractSenderUrn({})).toBe('');
  });
});

describe('extractBody', () => {
  it('handles object body with text field', () => {
    expect(extractBody({ body: { text: 'Hello' } })).toBe('Hello');
  });

  it('handles string body', () => {
    expect(extractBody({ body: 'Direct string' })).toBe('Direct string');
  });

  it('falls back to text field', () => {
    expect(extractBody({ text: 'Fallback text' })).toBe('Fallback text');
  });

  it('returns empty string when no body', () => {
    expect(extractBody({})).toBe('');
  });
});

describe('extractTimestamp', () => {
  it('converts createdAt ms to ISO string', () => {
    expect(extractTimestamp({ createdAt: 1700000000000 })).toBe(new Date(1700000000000).toISOString());
  });

  it('falls back to deliveredAt', () => {
    expect(extractTimestamp({ deliveredAt: 1700000001000 })).toBe(new Date(1700000001000).toISOString());
  });

  it('uses fallback ts when no fields present', () => {
    expect(extractTimestamp({}, 1700000002000)).toBe(new Date(1700000002000).toISOString());
  });

  it('returns empty string when nothing available', () => {
    expect(extractTimestamp({}, 0)).toBe('');
    expect(extractTimestamp({})).toBe('');
  });
});

// ── Piggyback parser (reads LinkedIn's own message fetch — the Option A win) ──
// Fixtures below are the REAL decorated structures captured from LinkedIn's
// messengerMessages GraphQL response during reverse-engineering.

describe('extractProfileId (self-match across URN shapes)', () => {
  it('extracts the id from a bare fsd_profile urn', () => {
    expect(extractProfileId('urn:li:fsd_profile:ACoAAC4I9rMBl782')).toBe('ACoAAC4I9rMBl782');
  });

  it('extracts the same id from a wrapped messagingParticipant urn', () => {
    expect(extractProfileId('urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAC4I9rMBl782'))
      .toBe('ACoAAC4I9rMBl782');
  });

  it('so both shapes match the same self id (the feedback-loop fix)', () => {
    const self = extractProfileId('urn:li:fsd_profile:ACoAAC4I9rMBl782');
    const sender = extractProfileId('urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAC4I9rMBl782');
    expect(self).toBe(sender);
    expect(self).toBeTruthy();
  });

  it('returns empty for a non-profile urn', () => {
    expect(extractProfileId('urn:li:messagingMessage:2-abc')).toBe('');
    expect(extractProfileId('')).toBe('');
  });
});

describe('extractMessageId', () => {
  it('extracts the 2-... id from a delivery ACK urn', () => {
    expect(extractMessageId('urn:li:msg_message:(urn:li:fsd_profile:ACoAAC4I9rMB,2-MTc4MzAxNTkzND==)'))
      .toBe('2-MTc4MzAxNTkzND==');
  });

  it('extracts the same id from a message backendUrn', () => {
    expect(extractMessageId('urn:li:messagingMessage:2-MTc4MzAxNTkzND=='))
      .toBe('2-MTc4MzAxNTkzND==');
  });

  it('returns empty for a urn without a message id', () => {
    expect(extractMessageId('urn:li:fsd_profile:ACoAAC4I9rMB')).toBe('');
    expect(extractMessageId('')).toBe('');
  });
});

describe('reconstructThreadIdFromMessageUrn', () => {
  it('reconstructs the thread id embedded in a real message urn', () => {
    // Real capture: this message urn decodes to
    // "1783015934053b23323-100&5fd09346-4514-4dbb-a943-39ac0c8a221d_100"
    const urn = 'urn:li:messagingMessage:2-MTc4MzAxNTkzNDA1M2IyMzMyMy0xMDAmNWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==';
    expect(reconstructThreadIdFromMessageUrn(urn))
      .toBe('2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==');
  });

  it('returns empty for a non-message urn', () => {
    expect(reconstructThreadIdFromMessageUrn('urn:li:fsd_profile:ACoAAC4I9rMB')).toBe('');
    expect(reconstructThreadIdFromMessageUrn('')).toBe('');
  });
});

describe('findMessageObjects', () => {
  it('finds decorated (_type) Message objects nested in elements arrays', () => {
    const resp = {
      data: { messengerMessagesBySyncTokensInBatch: [
        { elements: [
          { _type: 'com.linkedin.messenger.Message', body: { text: 'hi' }, backendUrn: 'urn:li:messagingMessage:2-A' },
        ] },
      ] },
    };
    const found = findMessageObjects(resp);
    expect(found).toHaveLength(1);
    expect(found[0].body.text).toBe('hi');
  });

  it('finds normalized ($type) Message objects too', () => {
    const resp = { included: [{ $type: 'com.linkedin.messenger.Message', backendUrn: 'urn:li:messagingMessage:2-B' }] };
    expect(findMessageObjects(resp)).toHaveLength(1);
  });

  it('ignores non-message objects', () => {
    expect(findMessageObjects({ a: { b: { _type: 'com.linkedin.messenger.Conversation' } } })).toHaveLength(0);
  });
});

describe('parseLinkedInOwnMessages', () => {
  // Real decorated Message element as LinkedIn's own client receives it.
  const realResponse = JSON.stringify({
    data: { messengerMessagesBySyncTokensInBatch: [{
      _type: 'com.linkedin.restli.common.CollectionResponse',
      elements: [{
        _type: 'com.linkedin.messenger.Message',
        body: { _type: 'com.linkedin.pemberly.text.AttributedText', text: 'RECON-MARKER-3-1783015923' },
        backendUrn: 'urn:li:messagingMessage:2-MTc4MzAxNTkzNDA1M2IyMzMyMy0xMDAmNWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==',
        deliveredAt: 1783015934053,
        actor: {
          _type: 'com.linkedin.messenger.MessagingParticipant',
          hostIdentityUrn: 'urn:li:fsd_profile:ACoAAGn0Vs8BxAAk7_n9O4OuKm4kUiHDHmtHl9Y',
          entityUrn: 'urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAGn0Vs8BxAAk7_n9O4OuKm4kUiHDHmtHl9Y',
          participantType: { member: { firstName: { text: 'Maya' }, lastName: { text: 'Solanki' } } },
        },
      }],
    }] },
  });

  it('extracts body, sender, urn, thread, and timestamp from the real response', () => {
    const msgs = parseLinkedInOwnMessages(realResponse, 0);
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.event_type).toBe('message');
    expect(m.body).toBe('RECON-MARKER-3-1783015923');
    expect(m.sender_urn).toBe('urn:li:fsd_profile:ACoAAGn0Vs8BxAAk7_n9O4OuKm4kUiHDHmtHl9Y');
    expect(m.message_urn).toBe('urn:li:messagingMessage:2-MTc4MzAxNTkzNDA1M2IyMzMyMy0xMDAmNWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==');
    expect(m.thread_id).toBe('2-NWZkMDkzNDYtNDUxNC00ZGJiLWE5NDMtMzlhYzBjOGEyMjFkXzEwMA==');
    expect(m.timestamp).toBe(new Date(1783015934053).toISOString());
  });

  it('filters out messages older than sinceMs', () => {
    expect(parseLinkedInOwnMessages(realResponse, 1783015934054)).toHaveLength(0);
    expect(parseLinkedInOwnMessages(realResponse, 1783015934053)).toHaveLength(1);
  });

  it('returns empty for non-message / base64 / unparseable input', () => {
    expect(parseLinkedInOwnMessages('base64:abc', 0)).toEqual([]);
    expect(parseLinkedInOwnMessages('not json', 0)).toEqual([]);
    expect(parseLinkedInOwnMessages(JSON.stringify({ data: { foo: 'bar' } }), 0)).toEqual([]);
    expect(parseLinkedInOwnMessages('', 0)).toEqual([]);
  });
});
