package com.personal.round.turn;

import static com.personal.round.config.RoundRoutes.BATON_TURN_CREDENTIALS_TEMPLATE;
import static com.personal.round.config.RoundRoutes.STANDALONE_TURN_CREDENTIALS;
import static org.springframework.http.HttpStatus.TOO_MANY_REQUESTS;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.auth.ParticipationGrantResolver;
import jakarta.servlet.http.HttpServletRequest;
import java.security.Principal;
import java.util.function.Supplier;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TurnCredentialController {

	private final TurnCredentialService credentialService;
	private final TurnCredentialRequestPolicy requestPolicy;
	private final ParticipationGrantResolver grantResolver;

	public TurnCredentialController(
			TurnCredentialService credentialService,
			TurnCredentialRequestPolicy requestPolicy,
			ParticipationGrantResolver grantResolver) {
		this.credentialService = credentialService;
		this.requestPolicy = requestPolicy;
		this.grantResolver = grantResolver;
	}

	@PostMapping(STANDALONE_TURN_CREDENTIALS)
	public ResponseEntity<TurnCredentials> credentials(HttpServletRequest request) {
		return issueCredentials(
				request,
				() -> credentialService.issueFor(request.getRemoteAddr()));
	}

	@PostMapping(BATON_TURN_CREDENTIALS_TEMPLATE)
	public ResponseEntity<TurnCredentials> credentials(
			@PathVariable String roomId,
			Principal principal,
			HttpServletRequest request) {
		ParticipationGrant grant = grantResolver.resolve(principal)
				.filter(candidate -> candidate.allows(roomId))
				.orElse(null);
		if (grant == null) {
			return forbidden();
		}
		return issueCredentials(
				request,
				() -> credentialService.issueFor(request.getRemoteAddr(), grant));
	}

	private ResponseEntity<TurnCredentials> issueCredentials(
			HttpServletRequest request,
			Supplier<TurnCredentialService.IssueResult> issuer) {
		if (!requestPolicy.allows(request)) {
			return forbidden();
		}
		TurnCredentialService.IssueResult result = issuer.get();
		return switch (result) {
			case TurnCredentialService.Issued issued -> ResponseEntity.ok()
					.cacheControl(CacheControl.noStore())
					.body(issued.credentials());
			case TurnCredentialService.RateLimited rateLimited ->
					ResponseEntity.status(TOO_MANY_REQUESTS)
							.header(
									HttpHeaders.RETRY_AFTER,
									Long.toString(rateLimited.retryAfterSeconds()))
							.cacheControl(CacheControl.noStore())
							.build();
			case TurnCredentialService.AuthorizationExpired ignored -> forbidden();
			case TurnCredentialService.Disabled ignored ->
					ResponseEntity.noContent()
							.cacheControl(CacheControl.noStore())
							.build();
		};
	}

	private static ResponseEntity<TurnCredentials> forbidden() {
		return ResponseEntity.status(HttpStatus.FORBIDDEN)
				.cacheControl(CacheControl.noStore())
				.build();
	}
}
