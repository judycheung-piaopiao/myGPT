import { useState, useEffect, useRef } from 'react';

export default function App() {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState([]);
  const [isStreamComplete, setIsStreamComplete] = useState(true); // 添加这个状态
  const typewriterQueueRef = useRef([]);
  const isTypingRef = useRef(false);
  const messagesEndRef = useRef(null);
  
  // 错误处理相关状态
  const [networkStatus, setNetworkStatus] = useState('online');
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef(null);

  // 网络状态监听
  useEffect(() => {
    const handleOnline = () => setNetworkStatus('online');
    const handleOffline = () => setNetworkStatus('offline');
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 添加系统消息
  const addSystemMessage = (text, type = 'info') => {
    setMessages(prev => [...prev, { 
      role: 'system', 
      text, 
      type,
      timestamp: Date.now() 
    }]);
  };

  // 取消当前请求
  const cancelRequest = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setConnectionStatus('idle');
      setIsStreamComplete(true);
      addSystemMessage('Request cancelled', 'info');
    }
  };

  // 自动滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 打字机效果处理函数
  const processTypewriterQueue = () => {
    if (isTypingRef.current || typewriterQueueRef.current.length === 0) {
      return;
    }
    isTypingRef.current = true;
    const chunk = typewriterQueueRef.current.shift();

    const chars = chunk.split('');
    let charIndex = 0;

    const typeInterval = setInterval(() => {
      if (charIndex < chars.length) {
        const char = chars[charIndex];
        
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            const updated = { ...last, text: last.text + char };
            return [...prev.slice(0, -1), updated];
          }
          return prev;
        });
        
        charIndex++;
      } else {
        clearInterval(typeInterval);
        isTypingRef.current = false;
        
        // 继续处理队列中的下一个块
        if (typewriterQueueRef.current.length > 0) {
          setTimeout(() => {
            processTypewriterQueue();
          }, 10);
        }
      }
    }, 20);
  };

  // 添加内容到打字机队列
  const addToTypewriterQueue = (chunk) => {
    typewriterQueueRef.current.push(chunk);
    processTypewriterQueue();
  };

  // 修复：正确的重试逻辑
  async function handleSubmitQuestion(input) {
    if (!input.trim()) return;
    
    // 检查网络状态
    if (networkStatus === 'offline') {
      addSystemMessage('Network offline.', 'error');
      return;
    }

    const maxRetries = 3;
    let currentRetry = 0;

    // 用户消息和AI占位消息
    const userMessage = { role: "user", text: input };
    const botMessage = { role: "assistant", text: "" };

    setMessages((prev) => [...prev, userMessage, botMessage]);
    setQuestion("");

    // 清空之前的打字机队列
    typewriterQueueRef.current = [];
    isTypingRef.current = false;
    setIsStreamComplete(false);

    // 关键修复：添加重试循环
    while (currentRetry <= maxRetries) {
      try {
        setConnectionStatus('connecting');
        setRetryCount(currentRetry);

        // 创建新的 AbortController
        abortControllerRef.current = new AbortController();
        
        // 设置30秒超时
        const timeoutId = setTimeout(() => {
          abortControllerRef.current?.abort();
        }, 30000);

        const res = await fetch("http://localhost:3001/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: input }),
          signal: abortControllerRef.current.signal
        });

        clearTimeout(timeoutId);
        
        // 检查响应状态
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        
        if (!res.body) {
          throw new Error('Empty response body');
        }

        setConnectionStatus('streaming'); 

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let lastReceiveTime = Date.now();
        
        while (true) {
          // 检查数据流超时（10秒无数据）
          const now = Date.now();
          if (now - lastReceiveTime > 10000) {
            throw new Error('Stream timeout');
          }
          
          const { done, value } = await reader.read();
          
          if (done) {
            setIsStreamComplete(true);
            setConnectionStatus('idle');
            setRetryCount(0);
            return; // 成功完成，退出函数
          }
          
          lastReceiveTime = now;
          const chunk = decoder.decode(value);
          
          // 将流式数据添加到打字机队列
          addToTypewriterQueue(chunk);
        }

      } catch (err) {
        console.error(`Request failed (attempt ${currentRetry + 1}/${maxRetries + 1}):`, err);
        
        // 取消可能还在进行的请求
        abortControllerRef.current?.abort();
        
        if (currentRetry === maxRetries) {
          // 最后一次重试失败
          setConnectionStatus('error');
          setIsStreamComplete(true);
            
          let errorMessage = 'Connection failed. Try again later';
          if (err.name === 'AbortError') {
            errorMessage = 'Request timeout. Check your network.';
          } else if (err.message.includes('HTTP')) {
            errorMessage = `Server error:${err.message}`;
          } else if (!navigator.onLine) {
            errorMessage = 'Network offline. Check your internet.';
          }
            
          addSystemMessage(errorMessage, 'error');
            
          // 移除空的AI消息
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.text === '') {
              return prev.slice(0, -1);
            }
            return prev;
          });
          
          return;
        }

        // 在每次重试前检查网络状态
      if (networkStatus === 'offline') {
        addSystemMessage('Network offline detected during retry. Waiting for connection...', 'warning');
        // 等待网络恢复
        while (networkStatus === 'offline') {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 每秒检查一次
        }
        addSystemMessage('Network restored. Continuing...', 'info');
      }

        // 准备重试
        currentRetry++;
        setConnectionStatus('retrying');
        setRetryCount(currentRetry);

        addSystemMessage(`Connection failed, retrying ${currentRetry}`, 'warning');
        
        // 指数退避：1s, 2s, 4s
        const retryDelay = Math.pow(2, currentRetry - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  // 获取连接状态显示
  const getConnectionStatusDisplay = () => {
    switch (connectionStatus) {
      case 'connecting':
        return { text: 'Connecting...', color: 'text-blue-600' };
      case 'streaming':
        return { text: 'Receiving response...', color: 'text-green-600' };
      case 'retrying':
        return { text: `Retrying (${retryCount}/3)...`, color: 'text-orange-600' };
      case 'error':
        return { text: 'Connection failed', color: 'text-red-600' };
      default:
        return null;
    }
  };

  const statusDisplay = getConnectionStatusDisplay();

  return (
    <main className="overflow-hidden w-full h-screen relative flex">
      <div className="flex max-w-full flex-1 flex-col">
        
        {/* 网络状态提示 */}
        {networkStatus === 'offline' && (
          <div className="bg-red-100 border-b border-red-200 px-4 py-2">
            <div className="text-red-800 text-sm text-center">
              ⚠️ Network connection lost. Check your internet.
            </div>
          </div>
        )}

        {/* 连接状态提示 */}
        {statusDisplay && (
          <div className="bg-gray-100 border-b border-gray-200 px-4 py-2">
            <div className={`text-sm text-center ${statusDisplay.color} flex items-center justify-center gap-2`}>
              <span>{statusDisplay.text}</span>
              {(connectionStatus === 'connecting' || connectionStatus === 'streaming' || connectionStatus === 'retrying') && (
                <button
                  onClick={cancelRequest}
                  className="text-xs bg-gray-200 hover:bg-gray-300 px-2 py-1 rounded"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        <div className="relative h-full w-full transition-width flex flex-col overflow-hidden items-stretch flex-1">
          <div className="flex-1 overflow-hidden dark:bg-gray-800">
            <h1 className="text-2xl sm:text-4xl font-semibold text-center text-gray-200 dark:text-gray-600 flex gap-4 p-4 items-center justify-center">
              My GPT
            </h1>
            <div className="h-4/5 overflow-auto">
              <div className="h-4/5 overflow-auto px-4 py-2 flex flex-col gap-3">
                {messages.map((m, i) => (
                  <div 
                    key={i} 
                    className={`flex ${
                      m.role === 'user' ? 'justify-end' : 
                      m.role === 'system' ? 'justify-center' : 'justify-start'
                    }`}
                  >
                    <div
                      className={`max-w-xs px-3 py-2 rounded-2xl text-sm relative ${
                        m.role === 'user'
                          ? 'bg-blue-500 text-white rounded-br-none'
                          : m.role === 'system'
                          ? `${
                              m.type === 'error' ? 'bg-red-100 text-red-800' :
                              m.type === 'warning' ? 'bg-orange-100 text-orange-800' :
                              'bg-blue-100 text-blue-800'
                            } text-xs`
                          : 'bg-gray-200 dark:bg-gray-700 text-black dark:text-white rounded-bl-none'
                      }`}
                    >
                      {m.text}
                      
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>
          </div>

          <div className="absolute bottom-0 left-0 w-full border-t md:border-t-0 dark:border-white/20 md:border-transparent md:dark:border-transparent md:bg-vert-light-gradient bg-white dark:bg-gray-800 md:!bg-transparent dark:md:bg-vert-dark-gradient pt-2">
            <div className="stretch mx-2 flex flex-row gap-3 last:mb-2 md:mx-4 md:last:mb-6 lg:mx-auto lg:max-w-2xl xl:max-w-3xl">
              <div className="relative flex flex-col h-full flex-1 items-stretch md:flex-col">
                <div className="flex flex-col w-full py-2 flex-grow md:py-3 md:pl-4 relative border border-black/10 bg-white dark:border-gray-900/50 dark:text-white dark:bg-gray-700 rounded-md shadow-[0_0_10px_rgba(0,0,0,0.10)] dark:shadow-[0_0_15px_rgba(0,0,0,0.10)]">
                  <textarea
                    value={question}
                    tabIndex={0}
                    data-id="root"
                    className="m-0 w-full resize-none border-0 bg-transparent p-0 pr-7 focus:ring-0 focus-visible:ring-0 dark:bg-transparent pl-2 md:pl-0"
                    onChange={(e) => setQuestion(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmitQuestion(question);
                      }
                    }}
                    placeholder="Ask something..."
                    disabled={connectionStatus === 'connecting' || connectionStatus === 'streaming' || networkStatus === 'offline'}
                  />
                  <button
                    onClick={() => handleSubmitQuestion(question)}
                    disabled={connectionStatus === 'connecting' || connectionStatus === 'streaming' || networkStatus === 'offline'}
                    className="absolute p-1 rounded-md bottom-1.5 md:bottom-2.5 bg-transparent disabled:bg-gray-500 right-1 md:right-2 disabled:opacity-40"
                  >
                    &#11157;
                  </button>
                </div>
              </div>
            </div>
            <div className="px-3 pt-2 pb-3 text-center text-xs text-black/50 dark:text-white/50 md:px-4 md:pt-3 md:pb-6">
              <span>
                Enhanced with error handling - The responses may include inaccurate information.
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}