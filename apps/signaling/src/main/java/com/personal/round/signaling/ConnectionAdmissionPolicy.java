package com.personal.round.signaling;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.config.SignalingProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public final class ConnectionAdmissionPolicy {

	public static final String RESERVATION_ATTRIBUTE =
			ConnectionAdmissionPolicy.class.getName() + ".reservation";

	private static final int MAX_CONNECTIONS_PER_PARTICIPATION_TOKEN = 1;
	private static final int MAX_CONNECTIONS_PER_PARTICIPANT_ROOM = 2;

	private final Object monitor = new Object();
	private final Map<String, Integer> connectionsByClient = new HashMap<>();
	private final Map<String, Integer> connectionsByParticipationToken = new HashMap<>();
	private final Map<ParticipantRoomKey, Integer> connectionsByParticipantRoom =
			new HashMap<>();
	private final int maxConnections;
	private final int maxConnectionsPerClient;
	private final SignalingMetrics metrics;
	private final ClientAddressKeyResolver clientAddressKeyResolver;
	private int activeReservations;

	public ConnectionAdmissionPolicy(
			SignalingProperties properties,
			SignalingMetrics metrics,
			ClientAddressKeyResolver clientAddressKeyResolver) {
		this.maxConnections = properties.maxConnections();
		this.maxConnectionsPerClient = properties.maxConnectionsPerClient();
		this.metrics = metrics;
		this.clientAddressKeyResolver = clientAddressKeyResolver;
	}

	public Admission reserve(
			InetSocketAddress remoteAddress,
			ParticipationGrant participationGrant) {
		String clientKey = clientAddressKeyResolver.resolve(remoteAddress);
		ParticipantRoomKey participantRoomKey =
				ParticipantRoomKey.from(participationGrant);
		String participationTokenId = participationGrant == null
				? null
				: participationGrant.tokenId();
		synchronized (monitor) {
			if (activeReservations >= maxConnections) {
				metrics.recordConnectionRejectedServerCapacity();
				return new Rejected(Rejection.SERVER_CAPACITY);
			}

			int clientConnections = connectionsByClient.getOrDefault(clientKey, 0);
			if (clientConnections >= maxConnectionsPerClient) {
				metrics.recordConnectionRejectedClientCapacity();
				return new Rejected(Rejection.CLIENT_CAPACITY);
			}

			if (participationTokenId != null
					&& connectionsByParticipationToken.getOrDefault(
									participationTokenId,
									0)
							>= MAX_CONNECTIONS_PER_PARTICIPATION_TOKEN) {
				metrics.recordConnectionRejectedParticipationTokenCapacity();
				return new Rejected(Rejection.PARTICIPATION_TOKEN_CAPACITY);
			}

			if (participantRoomKey != null
					&& connectionsByParticipantRoom.getOrDefault(
									participantRoomKey,
									0)
							>= MAX_CONNECTIONS_PER_PARTICIPANT_ROOM) {
				metrics.recordConnectionRejectedParticipantRoomCapacity();
				return new Rejected(Rejection.PARTICIPANT_ROOM_CAPACITY);
			}

			activeReservations++;
			increment(connectionsByClient, clientKey);
			increment(connectionsByParticipationToken, participationTokenId);
			increment(connectionsByParticipantRoom, participantRoomKey);
			return new Accepted(new Reservation(
					this,
					clientKey,
					participationTokenId,
					participantRoomKey));
		}
	}

	int activeReservationCount() {
		synchronized (monitor) {
			return activeReservations;
		}
	}

	int activeReservationCount(InetSocketAddress remoteAddress) {
		synchronized (monitor) {
			return connectionsByClient.getOrDefault(
					clientAddressKeyResolver.resolve(remoteAddress), 0);
		}
	}

	int activeParticipationTokenReservationCount(String tokenId) {
		synchronized (monitor) {
			return connectionsByParticipationToken.getOrDefault(tokenId, 0);
		}
	}

	int activeParticipantRoomReservationCount(ParticipationGrant grant) {
		synchronized (monitor) {
			return connectionsByParticipantRoom.getOrDefault(
					ParticipantRoomKey.from(grant),
					0);
		}
	}

	private void release(Reservation reservation) {
		synchronized (monitor) {
			if (reservation.released) {
				return;
			}
			reservation.released = true;
			activeReservations--;
			decrement(connectionsByClient, reservation.clientKey);
			decrement(
					connectionsByParticipationToken,
					reservation.participationTokenId);
			decrement(
					connectionsByParticipantRoom,
					reservation.participantRoomKey);
		}
	}

	private static <K> void increment(Map<K, Integer> counts, K key) {
		if (key != null) {
			counts.merge(key, 1, Integer::sum);
		}
	}

	private static <K> void decrement(Map<K, Integer> counts, K key) {
		if (key != null) {
			counts.computeIfPresent(
					key,
					(ignored, current) -> current == 1 ? null : current - 1);
		}
	}

	public enum Rejection {
		SERVER_CAPACITY,
		CLIENT_CAPACITY,
		PARTICIPATION_TOKEN_CAPACITY,
		PARTICIPANT_ROOM_CAPACITY
	}

	public sealed interface Admission permits Accepted, Rejected {
	}

	public record Accepted(Reservation reservation) implements Admission {
	}

	public record Rejected(Rejection reason) implements Admission {
	}

	public static final class Reservation implements AutoCloseable {

		private final ConnectionAdmissionPolicy owner;
		private final String clientKey;
		private final String participationTokenId;
		private final ParticipantRoomKey participantRoomKey;
		private boolean released;

		private Reservation(
				ConnectionAdmissionPolicy owner,
				String clientKey,
				String participationTokenId,
				ParticipantRoomKey participantRoomKey) {
			this.owner = owner;
			this.clientKey = clientKey;
			this.participationTokenId = participationTokenId;
			this.participantRoomKey = participantRoomKey;
		}

		String clientKey() {
			return clientKey;
		}

		@Override
		public void close() {
			owner.release(this);
		}
	}

	private record ParticipantRoomKey(
			String roomId,
			String subject) {

		private static ParticipantRoomKey from(ParticipationGrant grant) {
			return grant == null
					? null
					: new ParticipantRoomKey(
							grant.roomId(),
							grant.subject());
		}
	}
}
