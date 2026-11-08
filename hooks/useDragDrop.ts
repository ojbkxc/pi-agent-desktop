"use client";

import { useEffect, useState, useCallback, useRef } from "react";

function hasDraggedFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function useDragDrop(onDrop: (files: File[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // d5-35：非文件拖拽（如页内文本选择拖动）不得动文件拖拽的计数——否则 enter/leave
    // 计数失衡，高亮遮罩卡 true。
    if (!hasDraggedFiles(e)) return;
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onDrop(files);
  }, [onDrop]);

  // d5-35：dragend/drop 兜底——拖拽期间源节点被 React 重渲染/移除时，目标元素可能
  // 收不到配对的 dragleave，计数失衡会让高亮遮罩卡 true。窗口级一到即清零
  //（同页拖拽源的 dragend 必达窗口；跨窗文件拖拽由 drop/leave 覆盖）。
  useEffect(() => {
    if (!isDragOver) return;
    const reset = () => {
      counterRef.current = 0;
      setIsDragOver(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [isDragOver]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}
