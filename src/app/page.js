"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { FiArrowRight, FiSend } from "react-icons/fi";
import { v4 as uuidv4 } from "uuid"; // install uuid with `npm install uuid`

export default function Home() {
  const wsRef = useRef(null);
  const peerConnections = useRef({});
  const peersRef = useRef({});
  const messageQueue = useRef({}); // { peerId: [messages] }

  const [peers, setPeers] = useState({});
  const [messages, setMessages] = useState([]);
  const [msg, setMsg] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [connectedRoom, setConnectedRoom] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [myName, setMyName] = useState("");
  const chatBoxRef = useRef(null);
  const fileInputRef = useRef(null);
  const incomingFilesRef = useRef({}); // { [peerId_filename]: { chunks: [], size, received, metadata } }

  const buttonClass =
    "absolute right-0 top-1/2 -translate-y-1/2 w-20 h-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-r-xl flex items-center justify-center transition-transform duration-150 ease-in-out active:scale-95 shadow-md";

  /** Auto-scroll chat */
  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [messages]);

  /** Safe WebSocket send */
  const safeSend = useCallback((data) => {
    const str = JSON.stringify(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(str);
      console.log("Sent WS message:", data);
    } else {
      console.warn("WS not open, queueing message:", data);
      messageQueue.current._global = messageQueue.current._global || [];
      messageQueue.current._global.push(str);
    }
  }, []);

  /** WebSocket setup */
  useEffect(() => {
    const ws = new WebSocket("ws://192.168.1.4:4000");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      Object.values(messageQueue.current).forEach((queue) => {
        queue.forEach((msg) => ws.send(msg));
      });
      messageQueue.current = {};
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      console.log("Received WS message:", data);
      switch (data.type) {
        case "room-assigned":
        case "room-joined":
          setConnectedRoom(data.room);
          setMyName(data.name);
          break;
        case "new-peer":
          console.log("New peer:", data.id);
          setPeers((prev) => {
            const updated = { ...prev, [data.id]: { status: "pending" } };
            peersRef.current = updated;
            return updated;
          });
          callPeer(data.id);
          break;
        case "offer":
          await handleOffer(data);
          break;
        case "answer":
          await handleAnswer(data);
          break;
        case "candidate":
          await handleCandidate(data);
          break;
        case "peer-left":
          console.log("Peer left:", data.id);
          setPeers((prev) => {
            const updated = { ...prev };
            delete updated[data.id];
            peersRef.current = updated;
            return updated;
          });
          break;
        default:
          console.warn("Unknown message type:", data.type);
      }
    };

    ws.onerror = (err) => console.error("WebSocket error:", err);
    ws.onclose = () => console.log("WebSocket closed");

    return () => ws.close();
  }, []);

  /** Send message to a peer */
  const sendMessage = useCallback(
    (peerId, message) => {
      const dc = peersRef.current[peerId]?.dc;
      if (!dc) return console.warn(`No data channel for peer ${peerId}`);

      const msgObj = { sender: myName, message };

      if (dc.readyState !== "open") {
        console.warn(`DataChannel not open, queueing message for ${peerId}`);
        messageQueue.current[peerId] = messageQueue.current[peerId] || [];
        messageQueue.current[peerId].push(msgObj);
        return;
      }

      dc.send(JSON.stringify(msgObj));
      console.log(`Sent message to ${peerId}:`, message);
      setMessages((prev) => [...prev, msgObj]);
    },
    [myName]
  );

  /** Create Peer Connection */
  const createPeerConnection = useCallback(
    (peerId) => {
      const pc = new RTCPeerConnection();

      /** Data channel for caller */
      let dc;
      try {
        dc = pc.createDataChannel("chat");
        setupDataChannel(dc, peerId);
      } catch (err) {
        console.log("Data channel not created yet for caller", peerId);
      }

      /** Data channel for receiver */
      pc.ondatachannel = (event) => {
        console.log("Received data channel from", peerId);
        setupDataChannel(event.channel, peerId);
      };

      /** ICE candidate handling */
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          safeSend({ type: "candidate", to: peerId, candidate: event.candidate });
          console.log("Sent ICE candidate to", peerId);
        }
      };

      /** Connection state change */
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`Connection state for ${peerId}:`, state);
        setPeers((prev) => {
          const updated = {
            ...prev,
            [peerId]: { ...prev[peerId], status: state, dc, pc }
          };
          peersRef.current = updated;
          return updated;
        });
      };

      setPeers((prev) => {
        const updated = { ...prev, [peerId]: { ...prev[peerId], status: "connecting", dc, pc } };
        peersRef.current = updated;
        return updated;
      });

      return pc;
    },
    [safeSend]
  );

  /** Setup DataChannel helper */
  const setupDataChannel = (dc, peerId) => {
    /** On open */
    dc.onopen = () => {
      console.log("DataChannel open with", peerId);
      setPeers((prev) => {
        const updated = { ...prev, [peerId]: { ...prev[peerId], status: "connected", dc } };
        peersRef.current = updated;

        /** Flush queued messages */
        (messageQueue.current[peerId] || []).forEach((msg) => dc.send(msg));
        messageQueue.current[peerId] = [];

        return updated;
      });
    };

    /** DataChannel message handler */
    dc.onmessage = async (e) => {
      try {
        if (typeof e.data === "string") {
          /** Parse text or file metadata */
          const received = JSON.parse(e.data);

          /** Text message */
          if (received.message && received.sender) {
            setMessages((prev) => [
              ...prev,
              { sender: received.sender || peerId, message: received.message },
            ]);
            return;
          }

          /** File metadata */
          if (
            received.filename &&
            received.size &&
            received.totalChunks &&
            received.fileId
          ) {
            const fileId = received.fileId;
            incomingFilesRef.current[fileId] = {
              chunks: [],
              size: received.size,
              received: 0,
              metadata: received,
            };

            /** Add placeholder for progress UI */
            setMessages((prev) => [
              ...prev,
              {
                sender: received.sender || peerId,
                filename: received.filename,
                fileSize: received.size,
                fileBlob: null,
                progress: 0,
                fileId,
              },
            ]);
          }
        } else if (e.data instanceof ArrayBuffer) {
          /** Binary chunk: must find correct file by fileId */
          const fileId = Object.keys(incomingFilesRef.current).find(
            (id) => incomingFilesRef.current[id].received < incomingFilesRef.current[id].size
          );
          if (!fileId) return;

          const fileData = incomingFilesRef.current[fileId];

          /** Store chunk and update received bytes */
          fileData.chunks.push(e.data);
          fileData.received += e.data.byteLength;

          /** Update progress for UI */
          const progress = Math.min(
            100,
            Math.floor((fileData.received / fileData.size) * 100)
          );
          setMessages((prev) =>
            prev.map((msg) =>
              msg.fileId === fileId && !msg.fileBlob ? { ...msg, progress } : msg
            )
          );

          /** If fully received, combine chunks into a Blob */
          if (fileData.received >= fileData.size) {
            const combined = new Blob(fileData.chunks);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.fileId === fileId
                  ? { ...msg, fileBlob: combined, progress: 100 }
                  : msg
              )
            );

            /** Clean up */
            delete incomingFilesRef.current[fileId];
          }
        }
      } catch (err) {
        /** Handle errors safely */
        console.error("Error handling received message:", e.data, err);
      }
    };
  };

  /** Call peer */
  const callPeer = useCallback(
    async (peerId) => {
      const pc = createPeerConnection(peerId);
      peerConnections.current[peerId] = pc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      safeSend({ type: "offer", to: peerId, sdp: offer });
      console.log("Sent offer to", peerId);
    },
    [createPeerConnection, safeSend]
  );

  const handleOffer = useCallback(
    async (data) => {
      console.log("Received offer from", data.from);
      const pc = createPeerConnection(data.from);
      peerConnections.current[data.from] = pc;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      safeSend({ type: "answer", to: data.from, sdp: answer });
      console.log("Sent answer to", data.from);
    },
    [createPeerConnection, safeSend]
  );

  const handleAnswer = useCallback(async (data) => {
    console.log("Received answer from", data.from);
    await peerConnections.current[data.from]?.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }, []);

  const handleCandidate = useCallback(async (data) => {
    console.log("Received ICE candidate from", data.from);
    await peerConnections.current[data.from]?.addIceCandidate(new RTCIceCandidate(data.candidate));
  }, []);

  /** File drop handler with independent progress per file */
  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const BASE_CHUNK_SIZE = 256 * 1024; /** 256 KB per chunk */
    const MAX_BUFFER = 8 * 1024 * 1024; /** 8 MB max buffer */

    for (const file of files) {
      const totalChunks = Math.ceil(file.size / BASE_CHUNK_SIZE);
      const fileId = uuidv4();

      for (const { dc } of Object.values(peersRef.current)) {
        if (!dc || dc.readyState !== "open") continue;

        /** Send metadata first */
        dc.send(JSON.stringify({
          sender: myName,
          filename: file.name,
          size: file.size,
          totalChunks,
          fileId,
          type: file.type || "application/octet-stream"
        }));

        let offset = 0;
        let inFlight = 0;
        let dynamicWindow = 5; /** Initial concurrent chunks */

        /** Function to read a slice and send it */
        const sendChunk = async () => {
          if (offset >= file.size) return;

          /** Wait if DataChannel buffer is full */
          while (dc.bufferedAmount > MAX_BUFFER) {
            await new Promise(res => setTimeout(res, 20));
          }

          const slice = file.slice(offset, offset + BASE_CHUNK_SIZE);
          offset += BASE_CHUNK_SIZE;
          inFlight++;

          const chunk = await slice.arrayBuffer(); /** Only read this slice into memory */
          dc.send(chunk);
          inFlight--;

          /** Adjust window dynamically based on buffer usage */
          if (dc.bufferedAmount < MAX_BUFFER / 4 && dynamicWindow < 20) {
            dynamicWindow++;
          } else if (dc.bufferedAmount > MAX_BUFFER / 2 && dynamicWindow > 1) {
            dynamicWindow--;
          }

          /** Continue sending next chunk */
          if (offset < file.size) sendChunk();
        };

        /** Start initial window of concurrent chunks */
        const starters = [];
        for (let i = 0; i < dynamicWindow && offset < file.size; i++) {
          starters.push(sendChunk());
        }
        await Promise.all(starters);

        /** Wait until all chunks finish sending */
        while (inFlight > 0 || offset < file.size) {
          await new Promise(res => setTimeout(res, 20));
        }
      }

      /** Add local placeholder for UI */
      setMessages(prev => [
        ...prev,
        {
          sender: myName,
          filename: file.name,
          fileBlob: file, /** Use original File object, no need to store full ArrayBuffer */
          fileId,
          progress: 100
        }
      ]);
    }
  }, [myName]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const connectRoom = () => {
    if (!roomCode) return;
    safeSend({ type: "join", room: roomCode });
    console.log("Joining room:", roomCode);
    setRoomCode("");
  };

  return (
    <div className="h-screen w-screen bg-gray-100 flex items-center justify-center p-2 sm:p-4 font-sans">
      <div className="bg-white/70 backdrop-blur-xl rounded-2xl shadow-xl w-full max-w-md p-3 sm:p-4 flex flex-col gap-3 max-h-[90vh] overflow-auto">

        {/* Name */}
        <div className="bg-indigo-100 text-indigo-800 rounded-xl px-3 py-1.5 font-semibold shadow text-center truncate text-sm sm:text-base">{myName || "..."}</div>

        {/* Room Info */}
        <div className="flex items-center justify-between bg-white/30 backdrop-blur-md text-gray-800 rounded-xl px-3 py-2 shadow-sm font-medium text-sm">
          <span className="truncate">Room: {connectedRoom || "..."}</span>
          <button
            onClick={() => navigator.clipboard.writeText(connectedRoom)}
            className="bg-gray-100/70 hover:bg-gray-200 text-gray-800 px-2 py-1 rounded-full shadow-sm transition text-xs sm:text-sm"
          >
            Copy
          </button>
        </div>

        {/* Room Input */}
        <div className="relative w-full">
          <input
            className="w-full p-2.5 pr-16 rounded-xl border border-gray-300 bg-white text-gray-800 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 text-sm"
            placeholder="Enter room code"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") connectRoom();
            }}
          />
          <button
            onClick={connectRoom}
            className={`${buttonClass} rounded-r-xl`}
          >
            <FiArrowRight size={18} />
          </button>
        </div>

        {/* Connected Peers */}
        {Object.keys(peers).length > 0 && (
          <div className="flex flex-wrap gap-2 py-1 px-1">
            {Object.entries(peers).map(([peerId, peer]) => (
              <div
                key={peerId}
                className="flex items-center gap-2 bg-white/20 px-3 py-1 rounded-full shadow-sm"
                title={peerId}
              >
                {/* Status dot */}
                <span
                  className={`w-2 h-2 rounded-full ${peer.status === "connected"
                    ? "bg-green-500"
                    : peer.status === "disconnected"
                      ? "bg-yellow-400"
                      : "bg-red-400"
                    }`}
                />
                {/* Peer Name */}
                <span className="text-gray-800 text-sm truncate max-w-[120px] sm:max-w-[160px]">
                  {peerId}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Message Input */}
        <div className="relative w-full">
          <input
            className="w-full p-2.5 pr-16 rounded-xl border border-gray-300 bg-white text-gray-800 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 text-sm"
            placeholder="Type a message..."
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && msg.trim()) {
                Object.keys(peersRef.current).forEach(peerId => sendMessage(peerId, msg));
                setMsg("");
              }
            }}
          />
          <button
            onClick={() => {
              Object.keys(peersRef.current).forEach(peerId => sendMessage(peerId, msg));
              setMsg("");
            }}
            className={buttonClass}
          >
            <FiSend size={18} />
          </button>
        </div>

        {/* File Drop */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileInputRef.current?.click()}
          className={`h-24 sm:h-28 border-2 border-dashed rounded-2xl flex items-center justify-center text-gray-700 text-center text-sm sm:text-base transition cursor-pointer ${dragOver ? "border-gray-500 bg-gray-50" : "border-gray-300"
            }`}
        >
          {dragOver ? "Release to share files" : "Drag & drop files here or click to select"}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            className="hidden"
            onChange={(e) => {
              handleDrop({ dataTransfer: { files: e.target.files }, preventDefault: () => { } });
              e.target.value = ""; /** Reset so same files can trigger again */
            }}
          />
        </div>

        {/* Chat Messages */}
        <div
          className="h-40 sm:h-48 overflow-y-auto p-2 rounded-2xl border border-gray-300 bg-white/50 backdrop-blur-sm flex flex-col gap-2"
          ref={chatBoxRef}
        >
          {messages.map((m, i) => {
            const isMe = m.sender === myName;
            const baseClasses =
              "max-w-[75%] px-3 py-2 rounded-xl break-words text-sm shadow cursor-pointer transition transform duration-150";
            const colorClasses = isMe
              ? "self-end bg-indigo-600 text-white hover:scale-105"
              : "self-start bg-gray-200 text-gray-800 hover:scale-105";

            return (
              <div
                key={i}
                className={`${baseClasses} ${colorClasses}`}
                title={m.message || m.filename}
              >
                {/* File message */}
                {m.fileBlob || m.progress !== undefined ? (
                  <div
                    className="flex flex-col cursor-pointer"
                    onClick={() => {
                      if (!m.fileBlob) return;
                      const url = URL.createObjectURL(m.fileBlob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = m.filename || "download";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(url), 100);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg flex-shrink-0">📄</span>
                      <span className="truncate font-medium">{m.filename || "File"}</span>
                    </div>

                    {/* Progress bar for incoming files */}
                    {!m.fileBlob && m.progress !== undefined && m.progress < 100 && (
                      <div className="w-full h-1 rounded bg-gray-300 mt-1">
                        <div
                          className="h-1 rounded bg-indigo-500"
                          style={{ width: `${m.progress}%` }}
                        ></div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Text message */
                  <div
                    className="truncate w-full"
                    onClick={() => m.message && navigator.clipboard.writeText(m.message)}
                  >
                    {m.message
                      ? m.message.length > 100
                        ? m.message.slice(0, 100) + "…"
                        : m.message
                      : ""}
                  </div>
                )}

                {/* Sender for incoming messages (both text and files) */}
                {!isMe && (
                  <div className="text-[10px] mt-1 text-right text-gray-600">{m.sender}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
