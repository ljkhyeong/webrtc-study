package com.personal.round.turn;

import static org.springframework.http.HttpStatus.TOO_MANY_REQUESTS;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TurnCredentialController {

	private final TurnCredentialService credentialService;

	public TurnCredentialController(TurnCredentialService credentialService) {
		this.credentialService = credentialService;
	}

	@GetMapping("/api/turn-credentials")
	public ResponseEntity<TurnCredentials> credentials(HttpServletRequest request) {
		return switch (credentialService.issueFor(request.getRemoteAddr())) {
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
			case TurnCredentialService.Disabled ignored ->
					ResponseEntity.noContent()
							.cacheControl(CacheControl.noStore())
							.build();
		};
	}
}
