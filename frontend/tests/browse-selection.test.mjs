import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('파일 선택은 경로 기준점과 화면 정렬 순서를 사용한다', async t => {
  const server = await createServer({server:{middlewareMode:true,hmr:false},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}})
  try {
    const { selectBrowseEntry: select } = await server.ssrLoadModule('/src/utils/browseSelection.ts')
    const order = ['a','b','c','d','e']
    const paths = result => [...result.paths].sort()
    await t.test('일반 클릭은 단일 선택이며 이전 집합을 변경하지 않는다', () => {
      const original = new Set(['a','b'])
      const next = select(order, original, 'a', 'd')
      assert.deepEqual(paths(next), ['d'])
      assert.equal(next.anchor, 'd')
      assert.deepEqual([...original], ['a','b'])
    })
    await t.test('Ctrl/Cmd와 체크박스는 추가 또는 해제한다', () => {
      for (const options of [{additive:true},{toggle:true}]) {
        assert.deepEqual(paths(select(order,new Set(['a']),'a','c',options)),['a','c'])
        assert.deepEqual(paths(select(order,new Set(['a','c']),'a','c',options)),['a'])
      }
    })
    await t.test('Shift 끝점을 바꿔도 원래 기준점에서 범위를 다시 선택한다', () => {
      const first = select(order,new Set(['b']),'b','e',{range:true})
      assert.deepEqual(paths(first), ['b','c','d','e'])
      const next = select(order,first.paths,first.anchor,'c',{range:true})
      assert.deepEqual(paths(next), ['b','c'])
      assert.equal(next.anchor, 'b')
    })
    await t.test('Ctrl/Cmd+Shift 범위는 기존 선택을 보존한다', () => {
      assert.deepEqual(paths(select(order,new Set(['a','c']),'c','e',{range:true,additive:true})),['a','c','d','e'])
    })
    await t.test('정렬을 바꿔도 행 번호 대신 같은 파일에서 범위를 시작한다', () => {
      assert.deepEqual(paths(select(['d','b','e','c','a'],new Set(['b']),'b','c',{range:true})),['b','c','e'])
    })
    await t.test('기준점이 없거나 현재 폴더에 없으면 현재 항목만 선택한다', () => {
      for (const anchor of [null,'missing']) assert.deepEqual(paths(select(order,new Set(['a']),anchor,'d',{range:true})),['d'])
    })
  } finally { await server.close() }
})
