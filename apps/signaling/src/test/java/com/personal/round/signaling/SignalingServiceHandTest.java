package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.protocol.ClientMessage;
import org.junit.jupiter.api.Test;

class SignalingServiceHandTest extends SignalingServiceTestSupport {
	@Test
	void 같은_대기순서를_공유하고_중복요청_늦은조회_다시들기_퇴장을_처리한다() throws Exception {
		TestPeer a = peer("a");
		TestPeer b = peer("b");
		TestPeer legacy = peer("legacy");
		connect(a, b, legacy);
		service.handle(a.session(), join("가온"));
		String aId = a.nextJson().at("/payload/peerId").asString();
		service.handle(b.session(), join("나래"));
		String bId = b.nextJson().at("/payload/peerId").asString();
		a.nextJson();
		service.handle(legacy.session(), join("다온"));
		legacy.nextJson();
		a.nextJson();
		b.nextJson();
		service.handle(b.session(), hand(null));
		b.nextJson();
		service.handle(a.session(), hand(null));
		a.nextJson();
		b.nextJson();
		service.handle(b.session(), hand(true));
		a.nextJson();
		b.nextJson();
		service.handle(a.session(), hand(true));
		var first = a.nextJson();
		assertThat(first.at("/payload/peerIds").toString()).isEqualTo("[\"%s\",\"%s\"]".formatted(bId, aId));
		assertThat(b.nextJson().get("payload")).isEqualTo(first.get("payload"));
		service.handle(a.session(), hand(true));
		assertThat(a.nextJson().get("payload")).isEqualTo(first.get("payload"));
		assertThat(legacy.hasMessage(node -> node.path("type").asString().equals("room.hand.state"))).isFalse();
		service.handle(b.session(), hand(false));
		a.nextJson();
		b.nextJson();
		service.handle(b.session(), hand(true));
		a.nextJson();
		b.nextJson();
		service.handle(legacy.session(), hand(null));
		a.nextJson();
		b.nextJson();
		assertThat(legacy.nextJson().at("/payload/peerIds").toString()).isEqualTo("[\"%s\",\"%s\"]".formatted(aId, bId));
		service.disconnect(a.session());
		assertThat(b.nextJson().path("type").asString()).isEqualTo("peer.left");
		assertThat(b.nextJson().at("/payload/peerIds").toString()).isEqualTo("[\"%s\"]".formatted(bId));
		legacy.nextJson();
		legacy.nextJson();
		service.disconnect(b.session());
		legacy.nextJson();
		legacy.nextJson();
		service.disconnect(legacy.session());
		TestPeer next = peer("next");
		connect(next);
		service.handle(next.session(), join("새 참가자"));
		String nextId = next.nextJson().at("/payload/peerId").asString();
		service.handle(next.session(), hand(null));
		var state = next.nextJson();
		assertThat(state.at("/payload/peerIds").size()).isZero();
		assertThat(state.at("/payload/supportedPeerIds").toString()).isEqualTo("[\"%s\"]".formatted(nextId));
	}

	@Test
	void 미입장자와_다른_방의_요청을_거부한다() throws Exception {
		TestPeer a = peer("a");
		connect(a);
		service.handle(a.session(), hand(true));
		assertError(a.nextJson(), "NOT_IN_ROOM");
		service.handle(a.session(), join("가온"));
		a.nextJson();
		service.handle(a.session(), new ClientMessage.Hand("bcde-fghj-kmnp", null, true));
		assertError(a.nextJson(), "ROOM_MISMATCH");
		service.handle(a.session(), hand(null));
		assertThat(a.nextJson().at("/payload/peerIds").size()).isZero();
	}

	private ClientMessage.Hand hand(Boolean raised) {
		return new ClientMessage.Hand(ROOM_ID, null, raised);
	}
}
