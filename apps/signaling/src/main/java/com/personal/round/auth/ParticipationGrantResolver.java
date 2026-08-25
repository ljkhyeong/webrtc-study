package com.personal.round.auth;

import com.personal.round.protocol.RoomIdFormat;
import java.security.Principal;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

@Component
public final class ParticipationGrantResolver {

	private static final int MAX_SUBJECT_LENGTH = 256;
	private static final int MAX_STUDY_ID_LENGTH = 256;
	private static final int MAX_TOKEN_ID_LENGTH = 256;

	public Optional<ParticipationGrant> resolve(Principal principal) {
		if (!(principal instanceof JwtAuthenticationToken authentication)) {
			return Optional.empty();
		}
		return resolve(authentication.getToken());
	}

	static Optional<ParticipationGrant> resolve(Jwt jwt) {
		try {
			String subject = canonicalAccountId(jwt.getSubject());
			String studyId = boundedClaim(jwt.getClaimAsString("study_id"), MAX_STUDY_ID_LENGTH);
			String roomId = jwt.getClaimAsString("room_id");
			String tokenId = boundedClaim(jwt.getId(), MAX_TOKEN_ID_LENGTH);
			String rawRole = jwt.getClaimAsString("role");
			Instant issuedAt = jwt.getIssuedAt();
			Instant expiresAt = jwt.getExpiresAt();
			if (!RoomIdFormat.isCanonical(roomId)
					|| issuedAt == null
					|| expiresAt == null) {
				return Optional.empty();
			}
			if (!expiresAt.isAfter(issuedAt)) {
				return Optional.empty();
			}
			ParticipationGrant.Role role;
			if ("host".equals(rawRole)) {
				role = ParticipationGrant.Role.HOST;
			}
			else if ("participant".equals(rawRole)) {
				role = ParticipationGrant.Role.PARTICIPANT;
			}
			else {
				throw new IllegalArgumentException("JWT role claim is invalid");
			}
			return Optional.of(new ParticipationGrant(
					subject,
					studyId,
					roomId,
					role,
					tokenId,
					issuedAt,
					expiresAt));
		}
		catch (IllegalArgumentException | ClassCastException exception) {
			return Optional.empty();
		}
	}

	private static String canonicalAccountId(String value) {
		String subject = boundedClaim(value, MAX_SUBJECT_LENGTH);
		UUID accountId = UUID.fromString(subject);
		if (!accountId.toString().equals(subject)) {
			throw new IllegalArgumentException("JWT subject is not a canonical Account UUID");
		}
		return subject;
	}

	private static String boundedClaim(String value, int maximumLength) {
		if (value == null
				|| value.isBlank()
				|| value.length() > maximumLength
				|| !value.equals(value.trim())) {
			throw new IllegalArgumentException("JWT claim is missing or invalid");
		}
		return value;
	}
}
