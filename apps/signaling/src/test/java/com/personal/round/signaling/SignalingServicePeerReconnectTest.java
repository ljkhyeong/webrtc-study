package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import com.personal.round.protocol.ClientMessage;
import org.junit.jupiter.api.Test;

class SignalingServicePeerReconnectTest extends SignalingServiceTestSupport {
	@Test
	void sendsSameConnectionIdToBothPeersAndRejectsOtherRooms() throws Exception {
		TestPeer first = peer("first");
		TestPeer second = peer("second");
		connect(first, second);
		service.handle(first.session(), join("가온"));
		String firstId = first.nextJson().at("/payload/peerId").asString();
		service.handle(second.session(), join("나래"));
		String secondId = second.nextJson().at("/payload/peerId").asString();
		first.nextJson();
		service.handle(first.session(), new ClientMessage.Reconnect(OTHER_ROOM_ID, "retry", secondId));
		assertError(first.nextJson(), "ROOM_MISMATCH");
		service.handle(first.session(), new ClientMessage.Reconnect(ROOM_ID, "retry", secondId));
		var left = first.nextJson();
		var right = second.nextJson();
		assertThat(left.at("/payload/peerId").asString()).isEqualTo(secondId);
		assertThat(right.at("/payload/peerId").asString()).isEqualTo(firstId);
		assertThat(left.at("/payload/connectionId").asString()).isNotBlank().isEqualTo(right.at("/payload/connectionId").asString());
		assertThat(left.at("/payload/initiator").asBoolean()).isNotEqualTo(right.at("/payload/initiator").asBoolean());
		assertThat(service.participantCount(ROOM_ID)).isEqualTo(2);
	}
}
