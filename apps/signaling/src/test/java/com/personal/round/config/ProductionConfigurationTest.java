package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.auth.RoundAuthProperties;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class ProductionConfigurationTest {

	private final ApplicationContextRunner runner = new ApplicationContextRunner()
			.withInitializer(new ConfigDataApplicationContextInitializer())
			.withUserConfiguration(ConfigurationPropertiesBindingTest.PropertiesConfiguration.class);

	private ApplicationContextRunner production() {
		return runner.withPropertyValues(
				"spring.profiles.active=production",
				"ROUND_AUTH_ISSUER=https://b4ton.com",
				"ROUND_AUTH_JWK_SET_URI=https://b4ton.com/.well-known/round-participation-jwks.json",
				"ALLOWED_ORIGINS=https://b4ton.com");
	}

	@Test
	void readsBatonTurnUrlsAndMountedSecret(@TempDir Path secrets) throws Exception {
		String secret = "test-only-baton-turn-secret-32-characters";
		Files.writeString(secrets.resolve("round.turn.shared-secret"), secret);
		production().withPropertyValues(
				"spring.config.import=configtree:" + secrets + "/",
				"TURN_URLS=turn:turn.b4ton.com:3478?transport=udp,turns:turn.b4ton.com:5349?transport=tcp")
				.run(context -> {
					assertThat(context).hasNotFailed();
					assertThat(context.getBean(RoundAuthProperties.class).batonMode()).isTrue();
					TurnProperties turn = context.getBean(TurnProperties.class);
					assertThat(turn.provider()).isEqualTo(TurnProperties.Provider.COTURN);
					assertThat(turn.coturnUrls()).containsExactly(
							"turn:turn.b4ton.com:3478?transport=udp",
							"turns:turn.b4ton.com:5349?transport=tcp");
					assertThat(turn.coturnSecret()).isEqualTo(secret);
					assertThat(turn.toString()).doesNotContain(secret);
				});
	}

	@Test
	void explicitCoturnSettingsTakePrecedenceOverBatonAliases() {
		production().withPropertyValues(
				"TURN_COTURN_URLS=turn:turn.b4ton.com:3478?transport=tcp",
				"TURN_COTURN_SECRET=test-only-current-secret-32-characters",
				"TURN_URLS=turn:old.invalid:3478",
				"round.turn.shared-secret=test-only-previous-secret-32-characters")
				.run(context -> {
					assertThat(context).hasNotFailed();
					TurnProperties turn = context.getBean(TurnProperties.class);
					assertThat(turn.coturnUrls()).containsExactly("turn:turn.b4ton.com:3478?transport=tcp");
					assertThat(turn.coturnSecret()).isEqualTo("test-only-current-secret-32-characters");
				});
	}

	@Test
	void missingProductionSecretsFailInsteadOfDisablingTurn() {
		production().run(context -> assertThat(context).hasFailed());
		runner.withPropertyValues("spring.profiles.active=production", "TURN_PROVIDER=disabled")
				.run(context -> assertThat(context.getStartupFailure())
						.hasStackTraceContaining("BATON auth mode requires issuer and jwk-set-uri"));
	}

	@Test
	void explicitStandaloneAndDisabledSettingsRemainAvailable() {
		production().withPropertyValues("ROUND_AUTH_MODE=standalone", "TURN_PROVIDER=disabled")
				.run(context -> {
					assertThat(context).hasNotFailed();
					assertThat(context.getBean(RoundAuthProperties.class).batonMode()).isFalse();
					assertThat(context.getBean(TurnProperties.class).enabled()).isFalse();
				});
		runner.run(context -> {
			assertThat(context).hasNotFailed();
			assertThat(context.getBean(RoundAuthProperties.class).batonMode()).isFalse();
			assertThat(context.getBean(TurnProperties.class).enabled()).isFalse();
		});
	}
}
