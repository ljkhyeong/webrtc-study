package com.personal.round.signaling;

import com.personal.round.config.SignalingProperties;
import com.personal.round.net.ClientAddressKeyResolver;
import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import org.springframework.stereotype.Component;

@Component
public final class ConnectionAdmissionPolicy {

	public static final String RESERVATION_ATTRIBUTE =
			ConnectionAdmissionPolicy.class.getName() + ".reservation";

	private final Object monitor = new Object();
	private final Map<String, Integer> connectionsByClient = new HashMap<>();
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

	public Admission reserve(InetSocketAddress remoteAddress) {
		String clientKey = clientAddressKeyResolver.resolve(remoteAddress);
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

			activeReservations++;
			connectionsByClient.put(clientKey, clientConnections + 1);
			return new Accepted(new Reservation(this, clientKey));
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

	private void release(Reservation reservation) {
		synchronized (monitor) {
			if (reservation.released) {
				return;
			}
			reservation.released = true;
			activeReservations--;
			connectionsByClient.computeIfPresent(
					reservation.clientKey,
					(ignored, current) -> {
						int remaining = current - 1;
						return remaining == 0 ? null : remaining;
					});
		}
	}

	public enum Rejection {
		SERVER_CAPACITY,
		CLIENT_CAPACITY
	}

	public sealed interface Admission permits Accepted, Rejected {
	}

	public record Accepted(Reservation reservation) implements Admission {

		public Accepted {
			Objects.requireNonNull(reservation, "reservation");
		}
	}

	public record Rejected(Rejection reason) implements Admission {

		public Rejected {
			Objects.requireNonNull(reason, "reason");
		}
	}

	public static final class Reservation implements AutoCloseable {

		private final ConnectionAdmissionPolicy owner;
		private final String clientKey;
		private boolean released;

		private Reservation(ConnectionAdmissionPolicy owner, String clientKey) {
			this.owner = owner;
			this.clientKey = clientKey;
		}

		String clientKey() {
			return clientKey;
		}

		@Override
		public void close() {
			owner.release(this);
		}
	}
}
