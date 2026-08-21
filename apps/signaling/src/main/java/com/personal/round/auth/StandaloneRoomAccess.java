package com.personal.round.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

final class StandaloneRoomAccess implements RoomAccess {

	private final byte[] expectedHostTokenDigest;

	StandaloneRoomAccess(String hostTokenSha256) {
		this.expectedHostTokenDigest = hostTokenSha256 == null
				? new byte[0]
				: HexFormat.of().parseHex(hostTokenSha256);
	}

	@Override
	public boolean allows(String roomId) {
		return true;
	}

	@Override
	public Optional<ParticipationGrant.Role> roleFor(String hostCapability) {
		if (hostCapability == null) {
			return Optional.of(ParticipationGrant.Role.PARTICIPANT);
		}
		if (expectedHostTokenDigest.length == 0) {
			return Optional.empty();
		}

		byte[] candidateDigest = sha256(hostCapability);
		return MessageDigest.isEqual(expectedHostTokenDigest, candidateDigest)
				? Optional.of(ParticipationGrant.Role.HOST)
				: Optional.empty();
	}

	@Override
	public Lease openLease(long currentEpochMillis, long currentMonotonicNanos) {
		return Lease.withoutDeadline();
	}

	private static byte[] sha256(String value) {
		try {
			return MessageDigest.getInstance("SHA-256")
					.digest(value.getBytes(StandardCharsets.UTF_8));
		}
		catch (NoSuchAlgorithmException exception) {
			throw new IllegalStateException("SHA-256 is unavailable", exception);
		}
	}
}
