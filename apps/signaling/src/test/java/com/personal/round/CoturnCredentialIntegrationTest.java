package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verifyNoInteractions;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.turn.CloudflareTurnClient;
import com.personal.round.turn.TurnCredentialService;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"spring.profiles.active=production",
			"ALLOWED_ORIGINS=https://b4ton.com",
			"ROUND_AUTH_ISSUER=https://b4ton.com",
			"ROUND_AUTH_JWK_SET_URI=https://b4ton.com/.well-known/round-participation-jwks.json",
			"TURN_URLS=turn:turn.b4ton.com:3478?transport=udp,turns:turn.b4ton.com:5349?transport=tcp",
			"round.turn.shared-secret=integration-only-secret-32-characters",
			"round.turn.rate-limit-max-requests=2",
			"round.turn.rate-limit-global-max-requests=4"
		})
class CoturnCredentialIntegrationTest {
	@Autowired
	private TurnCredentialService service;

	@MockitoBean
	private CloudflareTurnClient cloudflare;

	@Test
	void issuesWithoutExternalApiAndRetainsGrantExpiryAndQuota() {
		Instant now = Instant.now();
		ParticipationGrant grant = new ParticipationGrant(
				"member-1", "study-1", "abcd-efgh-jkmp", ParticipationGrant.Role.PARTICIPANT,
				"ticket-1", now, now.plusSeconds(120));
		TurnCredentialService.Issued first = (TurnCredentialService.Issued) service.issueFor("192.0.2.1", grant);
		TurnCredentialService.Issued second = (TurnCredentialService.Issued) service.issueFor("192.0.2.1", grant);

		assertThat(first.credentials().urls()).containsExactly(
				"turn:turn.b4ton.com:3478?transport=udp", "turns:turn.b4ton.com:5349?transport=tcp");
		assertThat(first.credentials().expiresAt()).isEqualTo(grant.expiresAt().getEpochSecond());
		assertThat(first.credentials().username()).startsWith(grant.expiresAt().getEpochSecond() + ":");
		assertThat(first.credentials().username()).isNotEqualTo(second.credentials().username());
		assertThat(first.credentials().credential()).isNotEqualTo(second.credentials().credential());
		assertThat(service.issueFor("192.0.2.1", grant)).isInstanceOf(TurnCredentialService.RateLimited.class);
		verifyNoInteractions(cloudflare);
	}
}
