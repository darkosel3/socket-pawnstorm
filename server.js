const axios = require("axios");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Chess } = require("chess.js");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:5174",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const PORT = process.env.PORT || 3001;

// Store active games and waiting players
const games = {};
const waitingPlayers = [];
const playerSockets = {}; // Track socket to game mapping

io.on("connection", (socket) => {
  console.log(`✅ Novi korisnik konektovan: ${socket.id}`);

  // Handle player searching for game - UPDATED TO MATCH FRONTEND
  socket.on("findOpponent", (playerData) => {
    const playerName = playerData?.playerName || playerData?.name || "Guest";
    const playerType = playerData?.playerType || playerData?.type || "guest";
    const playerId = playerData?.playerId || null; // Dodaj ovo

    console.log(`🔍 ${playerName} traži protivnika (${playerType})`);

    // Očisti ako je već u waiting listi
    const waitingIndex = waitingPlayers.findIndex(
      (p) => p.socketId === socket.id
    );
    if (waitingIndex !== -1) {
      waitingPlayers.splice(waitingIndex, 1);
    }
    // Check if player is already in a game

    if (playerSockets[socket.id]) {
      socket.emit("error", { message: "Already in a game" });
      return;
    }

    // Check if there's a waiting player
    if (waitingPlayers.length > 0) {
      const opponent = waitingPlayers.shift();
      const gameId = `game_${Date.now()}`;

      // Create new chess game
      const chessGame = new Chess();

      // Randomly assign colors
      const isFirstPlayerWhite = Math.random() > 0.5;

      // Create game object
      games[gameId] = {
        gameId: gameId,
        whitePlayer: isFirstPlayerWhite
          ? {
              id: opponent.socketId,
              name: opponent.name,
              socketId: opponent.socketId,
              type: opponent.type,
              playerId: opponent.playerId ?? null, // <- koristi opponent.playerId
            }
          : {
              id: socket.id,
              name: playerName,
              socketId: socket.id,
              type: opponent.type,
              playerId: playerId ?? null, // <- koristi opponent.playerId
            },
        blackPlayer: isFirstPlayerWhite
          ? {
              id: socket.id,
              name: playerName,
              socketId: socket.id,
              type: opponent.type,
              playerId: playerId,
            }
          : {
              id: opponent.socketId,
              name: opponent.name,
              socketId: opponent.socketId,
              type: opponent.type,
              playerId: opponent.playerId ?? null, // <- koristi playerId od socket-a
            },
        gameState: chessGame.fen(),
        currentTurn: "w",
        moveHistory: [],
        status: "active",
        createdAt: new Date(),
        chess: chessGame, // Store chess instance
      };

      console.log(`🎮 Nova igra kreirana: ${gameId}`);
      console.log(`⚪ White: ${games[gameId].whitePlayer.name}`);
      console.log(`⚫ Black: ${games[gameId].blackPlayer.name}`);

      // Track both players
      playerSockets[opponent.socketId] = gameId;
      playerSockets[socket.id] = gameId;

      // Join both players to game room
      io.sockets.sockets.get(opponent.socketId)?.join(gameId);
      socket.join(gameId);

      // Send gameFound event to white player
      io.to(games[gameId].whitePlayer.socketId).emit("gameFound", {
        gameId: gameId,
        yourColor: "white",
        whitePlayer: games[gameId].whitePlayer,
        blackPlayer: games[gameId].blackPlayer,
        gameState: games[gameId].gameState,
        turn: games[gameId].currentTurn,
        moveHistory: games[gameId].moveHistory,
      });

      // Send gameFound event to black player
      io.to(games[gameId].blackPlayer.socketId).emit("gameFound", {
        gameId: gameId,
        yourColor: "black",
        whitePlayer: games[gameId].whitePlayer,
        blackPlayer: games[gameId].blackPlayer,
        gameState: games[gameId].gameState,
        turn: games[gameId].currentTurn,
        moveHistory: games[gameId].moveHistory,
      });
    } else {
      // Add to waiting list
      waitingPlayers.push({
        socketId: socket.id,
        name: playerName,
        type: playerType,
        playerId: playerId,
      });

      console.log(`⏳ ${playerName} čeka protivnika...`);
      socket.emit("waitingForOpponent");
    }
  });

  // Cancel search
  socket.on("cancelSearch", () => {
    const index = waitingPlayers.findIndex((p) => p.socketId === socket.id);
    if (index !== -1) {
      const player = waitingPlayers.splice(index, 1)[0];
      console.log(`❌ ${player.name} otkazao pretragu`);
    }
  });

  // Handle chess moves
  socket.on("makeMove", async (data) => {
    const { gameId, move } = data;

    if (!games[gameId]) {
      socket.emit("invalidMove", { reason: "Game not found" });
      return;
    }

    const game = games[gameId];
    const chess = game.chess;

    // Determine player color
    let playerColor = null;
    if (game.whitePlayer.socketId === socket.id) {
      playerColor = "w";
    } else if (game.blackPlayer.socketId === socket.id) {
      playerColor = "b";
    } else {
      socket.emit("invalidMove", { reason: "Not a player in this game" });
      return;
    }

    // Check if it's player's turn
    if (chess.turn() !== playerColor) {
      socket.emit("invalidMove", { reason: "Not your turn" });
      return;
    }

    // Try to make the move
    try {
      const result = chess.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || "q",
      });

      if (result) {
        // Update game state
        game.gameState = chess.fen();
        game.currentTurn = chess.turn();
        game.moveHistory = chess.history({ verbose: true });

        console.log(`♟️ Potez: ${result.san} u igri ${gameId}`);

        // Broadcast move to both players
        io.to(game.whitePlayer.socketId).emit("moveMade", {
          move: result,
          gameState: game.gameState,
          turn: game.currentTurn,
          moveHistory: game.moveHistory,
          yourColor: "white",
          isMyTurn: game.currentTurn === "w",
        });

        // za crnog
        io.to(game.blackPlayer.socketId).emit("moveMade", {
          move: result,
          gameState: game.gameState,
          turn: game.currentTurn,
          moveHistory: game.moveHistory,
          yourColor: "black",
          isMyTurn: game.currentTurn === "b",
        });
        // Check for game over
        if (chess.isGameOver()) {
          let gameOverData = null;

          if (chess.isCheckmate()) {
            const winner =
              chess.turn() === "w" ? game.blackPlayer : game.whitePlayer;
            const loser =
              chess.turn() === "w" ? game.whitePlayer : game.blackPlayer;

            gameOverData = {
              type: "checkmate",
              winner: winner,
              loser: loser,
              pgn: chess.pgn(),
            };
          } else if (chess.isDraw()) {
            let drawReason = "agreement";
            if (chess.isStalemate()) drawReason = "stalemate";
            else if (chess.isThreefoldRepetition())
              drawReason = "threefold repetition";
            else if (chess.isInsufficientMaterial())
              drawReason = "insufficient material";

            gameOverData = {
              type: "draw",
              reason: drawReason,
              pgn: chess.pgn(),
            };
          }

          if (gameOverData) {
            io.to(gameId).emit("gameOver", gameOverData);
            game.status = "finished";

            // Sačuvaj igru u bazu podataka
            try {
              const gameDataToSave = {
                white_player_id: game.whitePlayer.playerId ?? null,
                black_player_id: game.blackPlayer.playerId ?? null,
                game_type_id: 1,
                played_at: new Date().toISOString(),
                PGN: gameOverData.pgn,
              };

              console.log(gameDataToSave);
              const response = await axios.post(
                "http://localhost:8000/api/games",
                gameDataToSave
              );

              console.log("✅ Igra sačuvana u bazi:", response.data);
            } catch (error) {
              console.error("❌ Greška pri čuvanju igre:", error.message);
            }

            // Clean up after a delay
            setTimeout(() => {
              delete games[gameId];
              delete playerSockets[game.whitePlayer.socketId];
              delete playerSockets[game.blackPlayer.socketId];
            }, 60000); // Keep game for 1 minute after ending
          }
        }
      }
    } catch (error) {
      console.error("Invalid move:", error);
      socket.emit("invalidMove", { reason: "Invalid move" });
    }
  });

  // Handle resignation
  socket.on("resignGame", (data) => {
    const { gameId } = data;

    if (!games[gameId]) {
      return;
    }

    const game = games[gameId];

    // Determine who resigned
    let resignedPlayer, winner;
    if (game.whitePlayer.socketId === socket.id) {
      resignedPlayer = game.whitePlayer;
      winner = game.blackPlayer;
    } else if (game.blackPlayer.socketId === socket.id) {
      resignedPlayer = game.blackPlayer;
      winner = game.whitePlayer;
    } else {
      return;
    }

    console.log(`🏳️ ${resignedPlayer.name} je predao partiju ${gameId}`);

    // Send game over event
    io.to(gameId).emit("gameOver", {
      type: "resignation",
      winner: winner,
      resigned: resignedPlayer,
      pgn: game.chess.pgn(),
    });

    game.status = "finished";

    // Clean up after a delay
    setTimeout(() => {
      delete games[gameId];
      delete playerSockets[game.whitePlayer.socketId];
      delete playerSockets[game.blackPlayer.socketId];
    }, 60000);
  });

  // Handle chat messages
  socket.on("sendMessage", (data) => {
    const { gameId, message } = data;

    if (!games[gameId]) {
      return;
    }

    const game = games[gameId];
    let senderName = "Unknown";

    if (game.whitePlayer.socketId === socket.id) {
      senderName = game.whitePlayer.name;
    } else if (game.blackPlayer.socketId === socket.id) {
      senderName = game.blackPlayer.name;
    }

    console.log(`💬 ${senderName}: ${message}`);

    // Broadcast message to both players
    io.to(gameId).emit("newMessage", {
      sender: senderName,
      message: message,
      timestamp: new Date(),
    });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`❌ Korisnik se diskonektovao: ${socket.id}`);

    // Prvo proveri waiting listu
    const waitingIndex = waitingPlayers.findIndex(
      (p) => p.socketId === socket.id
    );
    if (waitingIndex !== -1) {
      const player = waitingPlayers.splice(waitingIndex, 1)[0];
      console.log(`🔴 ${player.name} uklonjen iz liste čekanja`);
      return; // Izađi ako je bio samo u waiting
    }

    // Check if player was in a game
    const gameId = playerSockets[socket.id];
    if (gameId && games[gameId]) {
      const game = games[gameId];

      let disconnectedPlayer;
      if (game.whitePlayer.socketId === socket.id) {
        disconnectedPlayer = game.whitePlayer;
      } else if (game.blackPlayer.socketId === socket.id) {
        disconnectedPlayer = game.blackPlayer;
      }

      if (disconnectedPlayer) {
        console.log(
          `⚠️ ${disconnectedPlayer.name} se diskonektovao iz igre ${gameId}`
        );

        // Notify the other player
        socket.to(gameId).emit("opponentDisconnected", {
          disconnectedPlayer: disconnectedPlayer,
        });

        // Don't immediately delete the game - allow reconnection
        // Mark game as having a disconnected player
        game.hasDisconnectedPlayer = true;
        game.disconnectedAt = new Date();

        // Clean up after 5 minutes if no reconnection
        setTimeout(() => {
          if (games[gameId] && game.hasDisconnectedPlayer) {
            console.log(`🗑️ Brisanje napuštene igre: ${gameId}`);
            delete games[gameId];
            delete playerSockets[game.whitePlayer.socketId];
            delete playerSockets[game.blackPlayer.socketId];
          }
        }, 300000); // 5 minutes
      }
    }

    // Clean up socket mapping
    delete playerSockets[socket.id];
  });

  // Handle reconnection attempt
  socket.on("rejoinGame", (data) => {
    const { gameId, playerName } = data;

    if (!games[gameId]) {
      socket.emit("error", { message: "Game not found" });
      return;
    }

    const game = games[gameId];

    // Determine which player is reconnecting
    let playerColor = null;
    if (game.whitePlayer.name === playerName) {
      game.whitePlayer.socketId = socket.id;
      playerColor = "white";
    } else if (game.blackPlayer.name === playerName) {
      game.blackPlayer.socketId = socket.id;
      playerColor = "black";
    } else {
      socket.emit("error", { message: "Not a player in this game" });
      return;
    }

    // Update socket mapping
    playerSockets[socket.id] = gameId;

    // Join game room
    socket.join(gameId);

    // Clear disconnection flag
    game.hasDisconnectedPlayer = false;

    console.log(`♻️ ${playerName} se ponovo pridružio igri ${gameId}`);

    // Send current game state
    socket.emit("gameJoined", {
      gameId: gameId,
      yourColor: playerColor,
      whitePlayer: game.whitePlayer,
      blackPlayer: game.blackPlayer,
      gameState: game.gameState,
      turn: game.currentTurn,
      moveHistory: game.moveHistory,
    });

    // Notify opponent
    socket.to(gameId).emit("opponentReconnected", {
      reconnectedPlayer: playerName,
    });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Socket server radi na http://localhost:${PORT}`);
});
