"""
WeBrain Reasoning Engine - Multi-step reasoning with LLM integration.

Supports:
- LLM-powered chain-of-thought reasoning
- Problem decomposition into sub-tasks
- Tool use decision making
- Context-aware logical analysis
"""

import json
import logging
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("webrain.reasoning")


class ReasoningEngine:
    """Multi-step reasoning engine with LLM backend."""

    def __init__(self, memory_manager: Any, llm_config: Optional[Dict[str, Any]] = None):
        self.memory = memory_manager
        self.llm_config = llm_config or {
            "base_url": "http://localhost:1234/v1",
            "model_id": "minimax/minimax-m2.7",
        }

    def _get_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=120.0)

    async def _chat_completion(self, messages: List[Dict[str, str]], tools: Optional[List[Dict]] = None, max_tokens: int = 2048) -> Dict[str, Any]:
        """Call LLM chat completions API."""
        url = self.llm_config["base_url"].rstrip("/") + "/chat/completions"
        payload: Dict[str, Any] = {
            "model": self.llm_config["model_id"],
            "messages": messages,
            "temperature": self.llm_config.get("temperature", 0.7),
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        headers = {"Content-Type": "application/json"}
        if self.llm_config.get("api_key"):
            headers["Authorization"] = f"Bearer {self.llm_config['api_key']}"

        try:
            async with self._get_client() as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            raise

    async def analyze(self, problem: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze a problem with LLM-powered multi-step reasoning."""
        # Retrieve relevant memories
        relevant = await self.memory.query({"query": problem, "levels": ["L2", "L3", "L4"], "limit": 10})
        memory_context = "\n".join([f"- {m.get('content', '')}" for m in relevant[:5]]) or "无相关记忆"

        # Normalize context to dict
        if isinstance(context, str):
            context = {"context": context}
        ctx_text = context.get('context', '无') if isinstance(context, dict) else '无'

        system_prompt = """你是一个多步推理引擎。请分析用户的问题，并给出结构化的推理过程。
要求：
1. 将问题分解为 2-5 个子任务
2. 每个子任务给出推理依据
3. 最终给出结论和置信度(0-1)
4. 如果问题涉及工具调用（如打开应用、搜索、执行命令等），请明确指出需要调用的工具"""

        user_prompt = f"""问题：{problem}
上下文：{ctx_text}
相关记忆：
{memory_context}

请以JSON格式回复：
{{
  "sub_tasks": ["任务1", "任务2", ...],
  "reasoning_chain": [
    {{"step": 1, "task": "任务1", "reasoning": "推理依据..."}}
  ],
  "conclusion": "结论...",
  "confidence": 0.85,
  "needs_tool": false,
  "suggested_tool": ""
}}"""

        try:
            result = await self._chat_completion([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ])
            content = result["choices"][0]["message"]["content"]
            # Extract JSON from markdown code block if present
            json_str = content
            if "```json" in content:
                json_str = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                json_str = content.split("```")[1].split("```")[0].strip()

            parsed = json.loads(json_str)
            return {
                "problem": problem,
                "reasoning_chain": parsed.get("reasoning_chain", []),
                "conclusion": parsed.get("conclusion", ""),
                "confidence": parsed.get("confidence", 0.5),
                "relevant_memories_count": len(relevant),
                "needs_tool": parsed.get("needs_tool", False),
                "suggested_tool": parsed.get("suggested_tool", ""),
                "raw_response": content,
            }
        except Exception as e:
            logger.error(f"LLM reasoning failed, falling back to rule-based: {e}")
            return await self._fallback_analyze(problem, context, relevant)

    async def _fallback_analyze(self, problem: str, context: Dict[str, Any], relevant: List[Dict]) -> Dict[str, Any]:
        """Rule-based fallback when LLM is unavailable."""
        sub_tasks = await self.decompose(problem)
        chain = []
        for i, task in enumerate(sub_tasks):
            chain.append({
                "step": i + 1,
                "task": task,
                "reasoning": f"基于上下文和记忆，子任务 {i+1} 处理：{task}",
                "evidence": [m.get("content", "") for m in relevant[:3]],
            })
        conclusion = f"分析 '{problem}' 通过 {len(sub_tasks)} 个步骤：" + "；".join(sub_tasks)
        return {
            "problem": problem,
            "reasoning_chain": chain,
            "conclusion": conclusion,
            "confidence": 0.5,
            "relevant_memories_count": len(relevant),
            "needs_tool": False,
            "suggested_tool": "",
            "raw_response": None,
        }

    async def decompose(self, problem: str) -> List[str]:
        """Decompose a complex problem into sub-tasks."""
        system_prompt = "你是一个任务分解专家。请将用户的问题分解为清晰的子任务列表。只返回JSON数组。"
        user_prompt = f'请将以下问题分解为子任务列表，以JSON格式返回如 ["子任务1", "子任务2"]：\n\n{problem}'

        try:
            result = await self._chat_completion([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ], max_tokens=512)
            content = result["choices"][0]["message"]["content"]
            json_str = content
            if "```" in content:
                json_str = content.split("```")[1].split("```")[0].strip()
            return json.loads(json_str)
        except Exception:
            # Rule-based fallback
            sub_tasks = []
            lower = problem.lower()
            if any(w in lower for w in ["write", "create", "generate", "写", "生成", "创建"]):
                sub_tasks = ["理解需求", "收集上下文", "生成内容", "审阅优化"]
            elif any(w in lower for w in ["explain", "how", "what", "解释", "说明", "什么是"]):
                sub_tasks = ["识别关键概念", "检索相关知识", "结构化解释", "验证准确性"]
            elif any(w in lower for w in ["debug", "fix", "error", "调试", "修复", "错误"]):
                sub_tasks = ["复现问题", "定位根因", "实施修复", "测试验证"]
            elif any(w in lower for w in ["open", "打开", "启动", "运行"]):
                sub_tasks = ["识别目标应用", "检查可用性", "执行打开命令", "确认状态"]
            elif any(w in lower for w in ["summarize", "summary", "总结", "概括"]):
                sub_tasks = ["阅读源材料", "提取关键点", "综合总结", "验证完整性"]
            else:
                sub_tasks = ["分析输入", "检索相关上下文", "构建回复", "验证输出"]
            return sub_tasks

    async def validate_hypothesis(self, hypothesis: str, evidence: List[str]) -> Dict[str, Any]:
        """Validate a hypothesis against evidence."""
        system_prompt = "你是一个假设验证专家。请评估假设是否成立，并给出置信度。以JSON格式回复。"
        user_prompt = f'假设：{hypothesis}\n证据：\n' + "\n".join([f"- {e}" for e in evidence]) + '\n\n请以JSON格式回复：{"valid": true/false, "confidence": 0.0-1.0, "reasoning": "..."}'

        try:
            result = await self._chat_completion([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ], max_tokens=512)
            content = result["choices"][0]["message"]["content"]
            json_str = content
            if "```" in content:
                json_str = content.split("```")[1].split("```")[0].strip()
            return json.loads(json_str)
        except Exception:
            score = min(len(evidence) * 0.3, 1.0)
            return {
                "hypothesis": hypothesis,
                "valid": score > 0.5,
                "confidence": score,
                "reasoning": "基于证据数量估算",
            }

    async def decide_tool_use(self, user_input: str, available_tools: List[str]) -> Dict[str, Any]:
        """Decide if a tool should be used and which one."""
        system_prompt = f"""你是一个工具选择专家。请判断用户输入是否需要调用工具。
可用工具：{', '.join(available_tools)}

请以JSON格式回复：
{{"should_use_tool": true/false, "tool_name": "工具名或空", "reasoning": "判断理由", "params": {{}}}}"""

        try:
            result = await self._chat_completion([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"用户输入：{user_input}"},
            ], max_tokens=512)
            content = result["choices"][0]["message"]["content"]
            json_str = content
            if "```" in content:
                json_str = content.split("```")[1].split("```")[0].strip()
            parsed = json.loads(json_str)
            return {
                "should_use_tool": parsed.get("should_use_tool", False),
                "tool_name": parsed.get("tool_name", ""),
                "reasoning": parsed.get("reasoning", ""),
                "params": parsed.get("params", {}),
            }
        except Exception as e:
            logger.error(f"Tool decision failed: {e}")
            return {"should_use_tool": False, "tool_name": "", "reasoning": "LLM不可用", "params": {}}
