"use client";
import { useState, version } from "react";
import { shout } from "./actions";
import styles from "./editor.module.css";

/* A client component of the zone: its own chunk, the host's React (the version is printed to compare). */
export function Editor() {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState("");
  return (
    <div className={styles.box} id="box">
      <input id="editor" value={text} onChange={(e) => setText(e.target.value)} />
      <button id="shout" onClick={async () => setAnswer(await shout(text))}>shout</button>
      <p id="answer">{answer}</p>
      <p id="react">react {version}</p>
      <p id="editor-version">editor v{process.env.ZONE_VERSION}</p>
    </div>
  );
}
