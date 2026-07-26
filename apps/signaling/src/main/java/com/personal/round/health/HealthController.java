package com.personal.round.health;

import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {

	@GetMapping("/healthz")
	public ResponseEntity<Map<String, String>> health() {
		return ResponseEntity.ok()
				.cacheControl(CacheControl.noStore())
				.body(Map.of("status", "ok"));
	}
}
