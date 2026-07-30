import { describe, expect, it } from 'vitest';

import { resolveRoomEndpoints } from './room-endpoints';

const ROOM_ID = 'abcd-efgh-jkmp';

describe('room transport endpoint resolution', () => {
  it.each([undefined, '', 'standalone'])(
    'keeps the standalone same-origin defaults for auth mode %s',
    (authMode) => {
      expect(
        resolveRoomEndpoints({
          authMode,
          location: {
            host: 'round.example.com',
            protocol: 'https:',
          },
          roomId: ROOM_ID,
        }),
      ).toEqual({
        signalingUrl: 'wss://round.example.com/signal',
        turnCredentialsUrl: '/api/turn-credentials',
        participationGrantRefreshUrl: null,
      });
    },
  );

  it('keeps standalone signaling and TURN overrides backward compatible', () => {
    expect(
      resolveRoomEndpoints({
        authMode: 'standalone',
        location: {
          host: 'round.example.com',
          protocol: 'https:',
        },
        roomId: ROOM_ID,
        signalingUrl: 'https://signal.example.net/custom-signal',
        turnCredentialsUrl: 'https://turn.example.net/credentials',
      }),
    ).toEqual({
      signalingUrl: 'wss://signal.example.net/custom-signal',
      turnCredentialsUrl: 'https://turn.example.net/credentials',
      participationGrantRefreshUrl: null,
    });
  });

  it.each([
    {
      expectedSignalingUrl: `ws://round.example.com/round/rooms/${ROOM_ID}/signal`,
      location: {
        host: 'round.example.com',
        protocol: 'http:',
      },
    },
    {
      expectedSignalingUrl: `wss://round.example.com/round/rooms/${ROOM_ID}/signal`,
      location: {
        host: 'round.example.com',
        protocol: 'https:',
      },
    },
  ])(
    'uses room-scoped same-origin BATON endpoints for $location.protocol',
    ({ expectedSignalingUrl, location }) => {
      const endpoints = resolveRoomEndpoints({
        authMode: 'baton',
        location,
        roomId: ROOM_ID,
      });

      expect(endpoints).toEqual({
        signalingUrl: expectedSignalingUrl,
        turnCredentialsUrl: `/round/rooms/${ROOM_ID}/turn-credentials`,
        participationGrantRefreshUrl: `/round/rooms/${ROOM_ID}/participation-grant/refresh`,
      });
      expect(endpoints.signalingUrl).toContain(`/rooms/${ROOM_ID}/`);
      expect(endpoints.turnCredentialsUrl).toContain(`/rooms/${ROOM_ID}/`);
      expect(endpoints.participationGrantRefreshUrl).toContain(`/rooms/${ROOM_ID}/`);
    },
  );

  it.each(['typo', 'BATON', 'stand-alone'])(
    'fails closed for an unsupported authentication mode %s',
    (authMode) => {
      expect(() =>
        resolveRoomEndpoints({
          authMode,
          location: {
            host: 'round.example.com',
            protocol: 'https:',
          },
          roomId: ROOM_ID,
        }),
      ).toThrow();
    },
  );

  it.each([
    { signalingUrl: 'wss://signal.example.net/signal' },
    { turnCredentialsUrl: 'https://turn.example.net/credentials' },
  ])('rejects endpoint overrides in BATON mode: %#', (overrides) => {
    expect(() =>
      resolveRoomEndpoints({
        authMode: 'baton',
        location: {
          host: 'round.example.com',
          protocol: 'https:',
        },
        roomId: ROOM_ID,
        ...overrides,
      }),
    ).toThrow();
  });

  it('treats blank BATON overrides as unset configuration', () => {
    expect(
      resolveRoomEndpoints({
        authMode: 'baton',
        location: {
          host: 'round.example.com',
          protocol: 'https:',
        },
        roomId: ROOM_ID,
        signalingUrl: '   ',
        turnCredentialsUrl: '\n',
      }),
    ).toEqual({
      signalingUrl: `wss://round.example.com/round/rooms/${ROOM_ID}/signal`,
      turnCredentialsUrl: `/round/rooms/${ROOM_ID}/turn-credentials`,
      participationGrantRefreshUrl: `/round/rooms/${ROOM_ID}/participation-grant/refresh`,
    });
  });

  it.each(['../other-room', 'ABCD-EFGH-JKMP', 'abcd-efgh-jkmp/extra'])(
    'rejects a non-canonical BATON room id %s',
    (roomId) => {
      expect(() =>
        resolveRoomEndpoints({
          authMode: 'baton',
          location: {
            host: 'round.example.com',
            protocol: 'https:',
          },
          roomId,
        }),
      ).toThrow();
    },
  );
});
