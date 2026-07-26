package com.personal.round;

import com.personal.round.config.SignalingProperties;
import com.personal.round.config.TurnProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
@EnableConfigurationProperties({SignalingProperties.class, TurnProperties.class})
public class SignalingApplication {

	public static void main(String[] args) {
		SpringApplication.run(SignalingApplication.class, args);
	}
}
