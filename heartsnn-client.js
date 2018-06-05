#!/usr/bin/env node

// This code shows how to use the grpc `play_hearts` protocol to communicate
// with the C++ HeartsNN `play_hearts` server.
// It is currently just a test application, as it automartically plays out a game
// just playing the first card that can be legally played.
// TODO: modify it so that it has a simple UI that enables a human to play.

const caller = require('grpc-caller');
const chai = require('chai');
const grpc = require('grpc');
const path = require('path');
const protobuf = require('protobufjs');

const { expect } = chai;

const proto_path = path.resolve(__dirname, './play_hearts.proto')

const hearts_proto = grpc.load(proto_path).playhearts;

async function main() {
  const protoRoot = await protobuf.load(proto_path);

  const ClientMessage = protoRoot.lookupType('playhearts.ClientMessage');
  const Player = protoRoot.lookupType('playhearts.Player');
  const StartGame = protoRoot.lookupType('playhearts.StartGame');
  const MyPlay = protoRoot.lookupType('playhearts.MyPlay');

  const client = caller('0.0.0.0:50057', proto_path, 'PlayHearts')

  // grpc-caller calls this a `call` object, but it is just a Node Duplex stream.
  // So I'm going to sessionStream it `sessionStream` to be clearer.
  const sessionStream = client.connect();

  let sessionToken = null;

  const clientApi = {
    player: ({name, email}) => ClientMessage.create({player: Player.create({name, email})}),
    startGame: () => ClientMessage.create({sessionToken, startGame: StartGame.create({})}),
    myPlay: ({card}) => ClientMessage.create({sessionToken, myPlay: MyPlay.create({card})}),
  };

  sessionStream.on('end', () => {
    console.log('Client received end of stream');
    process.exit(1);
  });

  // This is a map of functions, one for each kind of message that the server sends.
  // We populate it below.
  let responders = {}

  // This function can dispatch any server messsage to the correct responder below.
  function dispatch(d) {
    expect(d).to.have.property('res');
    const { res: kind } = d;
    const message = d[kind];
    expect(message).to.exist;
    expect(responders).to.have.property(kind);
    const {[kind]: respond} = responders;
    respond(message);
  }

  sessionStream.on('data', d => dispatch(d));

  sessionStream.on('error', err => {
    console.error('Client received error:', err);
    process.exit(1);
  })

  // This first message is essentially a login message, but
  // it triggers a chain reaction that will result in playing an entire game
  // to 100 points.
  sessionStream.write(clientApi.player({name: 'Jim', email: 'jim.lloyd@gmail.com'}));

  responders.hello = message => {
      ({sessionToken} = message);
      console.log('Obtained sessionToken:', sessionToken);

      // Respond with a startGame message.
      sessionStream.write(clientApi.startGame());
  };

  responders.hand = message => {
      const { cards } = message;
      console.log('Received hand:', cards);
  };

  responders.cardPlayed = message => {
    const { playNumber, player, card } = message;
    console.log('Received cardPlayed:', { playNumber, player, card });
  }

  responders.yourTurn = message => {
    const { playNumber, trickSoFar, trickSuit, legalPlays, hand } = message;
    console.log('Received yourTurn:', { playNumber, trickSoFar, trickSuit, legalPlays, hand });

    // A YourTurn message expects a MyPlay response.
    // This currently just plays the first legal card.
    // TODO: make a ncurses or even just simple CLI interface to let a human choose card to play
    const card = legalPlays.card[0];
    console.log('Playing card:', card);
    sessionStream.write(clientApi.myPlay({card}));
  }

  responders.trickResult = message => {
    const { trickWinner, points } = message;
    console.log('Received trickResult:', { trickWinner, points });
  }

  let timeout = null;

  responders.handResult = message => {
    const { scores, totals, referenceScores, referenceTotals } = message;
    console.log('Received handResult:', { scores, totals, referenceScores, referenceTotals });

    // This is a bit of a hack.
    // After most hands, we immediately want to start another hand (TODO: fix that we the protocol is 'startGame')
    // But if 100 points have been reached, we don't want to start another hand.
    // Which means we have to wait to see if the next message is a GameResult message.
    // So we schedule a startGame message for one second from now, and then
    // cancel it when we receive the gameResult message below.
    // This also gives a developer watching the log time to see the end of each hand.
    timeout = setTimeout(() => sessionStream.write(clientApi.startGame()), 1000);
  }

  responders.gameResult = message => {
    clearTimeout(timeout);
    timeout = null;
    const { winner, totals, referenceTotals } = message;
    console.log('Received gameResult:', { winner, totals, referenceTotals });

    // We end the session here, which causes a clean disconnect from the server.
    sessionStream.end();
  }
}

main();
