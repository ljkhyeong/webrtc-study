package com.personal.round.auth;

import com.personal.round.protocol.RoomIdFormat;
import java.time.Instant;
import java.util.UUID;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/** 검증한 BATON 참여권 JWT의 인증 주체를 {@link ParticipationGrant}로 만든다. 클레임 형식이 다르면 401로 거부한다. */
final class ParticipationGrantAuthenticationConverter
		implements Converter<Jwt, AbstractAuthenticationToken> {

	private static final int MAX_SUBJECT_LENGTH = 256;
	private static final int MAX_STUDY_ID_LENGTH = 256;
	private static final int MAX_TOKEN_ID_LENGTH = 256;

	@Override
	public AbstractAuthenticationToken convert(Jwt jwt) {
		return new JwtAuthenticationToken(jwt, grantOf(jwt), AuthorityUtils.NO_AUTHORITIES);
	}

	private static ParticipationGrant grantOf(Jwt jwt) {
		try {
			String subject = canonicalAccountId(jwt.getSubject());
			boundedClaim(jwt.getClaimAsString("study_id"), MAX_STUDY_ID_LENGTH);
			String roomId = jwt.getClaimAsString("room_id");
			String tokenId = boundedClaim(jwt.getId(), MAX_TOKEN_ID_LENGTH);
			Instant issuedAt = jwt.getIssuedAt();
			Instant expiresAt = jwt.getExpiresAt();
			if (!RoomIdFormat.isCanonical(roomId)
					|| issuedAt == null
					|| expiresAt == null
					|| !expiresAt.isAfter(issuedAt)) {
				throw new IllegalArgumentException("JWT room or lifetime claim is invalid");
			}
			ParticipationGrant.Role role = switch (jwt.getClaimAsString("role")) {
				case "host" -> ParticipationGrant.Role.HOST;
				case "participant" -> ParticipationGrant.Role.PARTICIPANT;
				case null, default -> throw new IllegalArgumentException("JWT role claim is invalid");
			};
			return new ParticipationGrant(subject, roomId, role, tokenId, expiresAt);
		}
		catch (IllegalArgumentException exception) {
			throw new InvalidBearerTokenException(
					"The token is not a valid ROUND participation grant",
					exception);
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
