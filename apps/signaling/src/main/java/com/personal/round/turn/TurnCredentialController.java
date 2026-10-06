package com.personal.round.turn;

import static com.personal.round.config.RoundRoutes.BATON_TURN_CREDENTIALS_TEMPLATE;
import static com.personal.round.config.RoundRoutes.STANDALONE_TURN_CREDENTIALS;
import static org.springframework.http.HttpStatus.TOO_MANY_REQUESTS;

import com.personal.round.auth.ParticipationGrant;
import jakarta.servlet.http.HttpServletRequest;
import java.util.function.Supplier;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TurnCredentialController {

	private final TurnCredentialService credentialService;

	public TurnCredentialController(TurnCredentialService credentialService) {
		this.credentialService = credentialService;
	}

	@PostMapping(STANDALONE_TURN_CREDENTIALS)
	public ResponseEntity<TurnCredentials> credentials(HttpServletRequest request) {
		return issueCredentials(
				request,
				() -> credentialService.issueFor(request.getRemoteAddr()));
	}

	// 방 일치는 보안 필터 체인의 인가 규칙이 확인한다.
	@PostMapping(BATON_TURN_CREDENTIALS_TEMPLATE)
	public ResponseEntity<TurnCredentials> credentials(
			@AuthenticationPrincipal ParticipationGrant grant,
			HttpServletRequest request) {
		return issueCredentials(
				request,
				() -> credentialService.issueFor(request.getRemoteAddr(), grant));
	}

	private ResponseEntity<TurnCredentials> issueCredentials(
			HttpServletRequest request,
			Supplier<TurnCredentialService.IssueResult> issuer) {
		if (!TurnCredentialRequestPolicy.allows(request)) {
			return forbidden();
		}
		TurnCredentialService.IssueResult result = issuer.get();
		return switch (result) {
			case TurnCredentialService.Issued issued -> ResponseEntity.ok(issued.credentials());
			case TurnCredentialService.RateLimited rateLimited ->
					ResponseEntity.status(TOO_MANY_REQUESTS)
							.header(
									HttpHeaders.RETRY_AFTER,
									Long.toString(rateLimited.retryAfterSeconds()))
								.build();
			case TurnCredentialService.AuthorizationExpired ignored -> forbidden();
			case TurnCredentialService.ProviderUnavailable ignored ->
					ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
			case TurnCredentialService.Disabled ignored ->
					ResponseEntity.noContent().build();
		};
	}

	private static ResponseEntity<TurnCredentials> forbidden() {
		return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
	}
}
