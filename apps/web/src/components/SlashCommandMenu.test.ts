import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SlashCommandMenu from './SlashCommandMenu.vue';
import type { SlashCommandItem } from '../features/composer/slash-commands';

const mockCommands: SlashCommandItem[] = [
  {
    name: 'clear',
    displayName: 'Clear',
    description: 'Clear the conversation',
    category: 'builtin',
  },
  {
    name: 'code-review',
    displayName: 'Code Review',
    description: 'Review code',
    category: 'builtin',
  },
];

describe('SlashCommandMenu', () => {
  it('renders correctly', () => {
    const wrapper = mount(SlashCommandMenu, {
      props: {
        commands: mockCommands,
        query: '',
        visible: true,
      },
    });

    expect(wrapper.findAll('.command-item')).toHaveLength(2);
  });

  it('filters commands based on query', async () => {
    const wrapper = mount(SlashCommandMenu, {
      props: {
        commands: mockCommands,
        query: 'cle',
        visible: true,
      },
    });

    expect(wrapper.findAll('.command-item')).toHaveLength(1);
    expect(wrapper.text()).toContain('Clear');
  });

  it('emits select event when command is clicked', async () => {
    const wrapper = mount(SlashCommandMenu, {
      props: {
        commands: mockCommands,
        query: '',
        visible: true,
      },
    });

    await wrapper.find('.command-item').trigger('click');
    expect(wrapper.emitted('select')).toBeTruthy();
  });

  it('handles keyboard navigation', async () => {
    const wrapper = mount(SlashCommandMenu, {
      props: {
        commands: mockCommands,
        query: '',
        visible: true,
      },
    });

    const { handleKeyDown } = wrapper.vm;

    // Test ArrowDown
    handleKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(wrapper.vm.selectedIndex).toBe(1);

    // Test ArrowUp
    handleKeyDown({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(wrapper.vm.selectedIndex).toBe(0);

    // Test Enter
    handleKeyDown({ key: 'Enter', preventDefault: vi.fn() });
    expect(wrapper.emitted('select')).toBeTruthy();
  });
});
